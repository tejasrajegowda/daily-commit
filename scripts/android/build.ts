// The one way to run Gradle for this project, behind the memory gate.
// node scripts/android/build.ts release → web build, cap sync, Gradle assembleRelease, the APK check.
// node scripts/android/build.ts test    → Gradle :app:testDebugUnitTest, then a summary of the JVM tests.
// Gradle runs in one process with no daemon (android/gradle.properties), its output goes to
// .local/logs/, and only the last lines are printed. Nothing is left running afterwards.
import { spawn, spawnSync } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { freemem } from 'node:os';
import { join } from 'node:path';
import { childEnv, missingTools, toolchain, toolPaths } from './env.ts';
import { GB, readHeavy, waitForRoom } from './memory.ts';

const RESULTS_DIR = 'android/app/build/test-results/testDebugUnitTest';
const TAIL_LINES = 25;

/** Adds up the counts on every <testsuite> of the JUnit result files. */
export function junitSummary(xmlTexts: readonly string[]): { tests: number; failures: number; errors: number; skipped: number } {
  const sum = { tests: 0, failures: 0, errors: 0, skipped: 0 };
  for (const text of xmlTexts) {
    for (const tag of text.matchAll(/<testsuite\b([^>]*)>/g)) {
      const attr = (name: string) => Number(new RegExp(`\\s${name}="(\\d+)"`).exec(tag[1] ?? '')?.[1] ?? 0);
      sum.tests += attr('tests');
      sum.failures += attr('failures');
      sum.errors += attr('errors');
      sum.skipped += attr('skipped');
    }
  }
  return sum;
}

function failingTests(xmlTexts: readonly string[]): string[] {
  const names: string[] = [];
  for (const text of xmlTexts) {
    for (const m of text.matchAll(/<testcase\b([^>]*)>([\s\S]*?)<\/testcase>/g)) {
      if (!/<(failure|error)\b/.test(m[2] ?? '')) continue;
      const name = /\sname="([^"]*)"/.exec(m[1] ?? '')?.[1] ?? '?';
      const cls = /\sclassname="([^"]*)"/.exec(m[1] ?? '')?.[1] ?? '?';
      names.push(`${cls}.${name}`);
    }
  }
  return names;
}

function stamp(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/** Runs Gradle as the wrapper does (without gradlew.bat), logging to .local/logs/; resolves to its exit code. */
async function gradle(mode: string, tasks: readonly string[], java: string, env: Record<string, string>): Promise<number> {
  mkdirSync(join('.local', 'logs'), { recursive: true });
  const logPath = join('.local', 'logs', `android-${mode}-${stamp(new Date())}.log`);
  const log = createWriteStream(logPath);
  const tail: string[] = [];
  let partial = '';
  const keep = (chunk: Buffer) => {
    log.write(chunk);
    const lines = (partial + chunk.toString('utf8')).split(/\r?\n/);
    partial = lines.pop() ?? '';
    tail.push(...lines);
    if (tail.length > TAIL_LINES) tail.splice(0, tail.length - TAIL_LINES);
  };
  const started = Date.now();
  let lowestFree = freemem();
  const sampler = setInterval(() => { lowestFree = Math.min(lowestFree, freemem()); }, 5_000);
  const code = await new Promise<number>(resolve => {
    const child = spawn(java, ['-Xmx64m', '-Xms64m', '-Dorg.gradle.appname=gradlew', '-jar', join('gradle', 'wrapper', 'gradle-wrapper.jar'),
      '--no-daemon', '--console=plain', ...tasks], { cwd: 'android', env, windowsHide: true });
    child.stdout.on('data', keep);
    child.stderr.on('data', keep);
    child.on('error', () => resolve(1));
    child.on('close', c => resolve(c ?? 1));
  });
  clearInterval(sampler);
  if (partial) tail.push(partial);
  await new Promise<void>(resolve => log.end(resolve));
  for (const line of tail.slice(-TAIL_LINES)) console.log(line);
  const minutes = ((Date.now() - started) / 60_000).toFixed(1);
  console.log(`gradle: exit ${code} after ${minutes} min; lowest free memory during it ${(lowestFree / GB).toFixed(1)} GB; log ${logPath.split('\\').join('/')}`);
  return code;
}

function npmBuild(): number {
  // npm is a shell script on Windows, so it goes through the shell as one fixed string
  return spawnSync('npm run build', { stdio: 'inherit', shell: true }).status ?? 1;
}

function node(args: readonly string[], env: Record<string, string>): number {
  return spawnSync(process.execPath, args, { stdio: 'inherit', env }).status ?? 1;
}

async function main(mode: string | undefined): Promise<number> {
  if (mode !== 'release' && mode !== 'test') {
    console.log('usage: node scripts/android/build.ts release|test');
    return 2;
  }
  const tc = toolchain(process.env);
  const missing = missingTools(tc, existsSync);
  if (missing.length) {
    console.log(`missing: ${missing.join(', ')}; see Task 1, Step 0`);
    return 1;
  }
  const env = childEnv(tc, process.env);
  if (!(await waitForRoom('gradle'))) return 3;
  console.log(`memory gate: room to build, ${(freemem() / GB).toFixed(1)} GB free`);
  const java = toolPaths(tc).java;

  let code: number;
  if (mode === 'release') {
    code = npmBuild();
    if (code === 0) code = node(['node_modules/@capacitor/cli/bin/capacitor', 'sync', 'android'], env);
    if (code === 0) code = await gradle(mode, ['assembleRelease'], java, env);
    if (code === 0) code = node(['scripts/android/apk-check.ts'], env);
  } else {
    code = await gradle(mode, [':app:testDebugUnitTest'], java, env);
    const xml = existsSync(RESULTS_DIR)
      ? readdirSync(RESULTS_DIR).filter(f => f.endsWith('.xml')).map(f => readFileSync(join(RESULTS_DIR, f), 'utf8'))
      : [];
    const s = junitSummary(xml);
    console.log(`JVM tests: ${s.tests - s.failures - s.errors - s.skipped} passed, ${s.failures} failed, ${s.errors} errors, ${s.skipped} skipped`);
    for (const name of failingTests(xml)) console.log(`  failed: ${name}`);
    if (code === 0 && (s.failures > 0 || s.errors > 0)) code = 1;
  }
  const after = readHeavy();
  console.log(`after: ${after.gradleBuilds} Gradle build(s), ${after.emulators} emulator(s) running; ${(after.freeBytes / GB).toFixed(1)} GB free`);
  return code;
}

if (import.meta.main) {
  process.exitCode = await main(process.argv[2]);
}
