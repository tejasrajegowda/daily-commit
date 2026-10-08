// Checks the Android release APK after the build: the permanent identity (a new app id, scheme or
// hostname would be a new origin, and the stored record lives under the old one), no debuggable
// build, no web debugging or logging, and web assets that pass the release check and are exactly
// what was synced. Run by `npm run android:build`, or on its own with `npm run android:check`.
// node scripts/android/apk-check.ts → one line per problem, exit 1 if there is any.
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join, relative, sep } from 'node:path';
import { releaseProblems } from '../release-check.ts';
import { childEnv, toolchain, toolPaths } from './env.ts';

export const APP_ID = 'app.dailycommit';
export const UNSIGNED_APK = 'android/app/build/outputs/apk/release/app-release-unsigned.apk';
const PUBLIC_DIR = 'android/app/src/main/assets/public';
const TEXT = new Set(['.html', '.js', '.mjs', '.css', '.json', '.txt', '.svg', '.map']);

export interface ApkView {
  readonly manifest: string;                          // apkanalyzer manifest print
  readonly config: string;                            // assets/capacitor.config.json from the APK
  readonly publicFiles: ReadonlyMap<string, string>;  // android/app/src/main/assets/public/**, text files' text
  readonly apkPublicList: readonly string[];          // the APK's entries under assets/public/, relative
  readonly resources?: ReadonlyMap<string, string>;   // Task 2a: res/xml/…, res/layout/… as decoded XML
}

export function apkProblems(apk: ApkView): string[] {
  return [...manifestProblems(apk.manifest), ...configProblems(apk.config), ...assetProblems(apk)];
}

function manifestProblems(manifest: string): string[] {
  const problems: string[] = [];
  const pkg = /<manifest\b[^>]*\spackage="([^"]*)"/.exec(manifest);
  if (pkg?.[1] !== APP_ID) problems.push(`manifest: package is ${pkg?.[1] ?? 'missing'}, not ${APP_ID}`);
  if (/android:debuggable="true"/.test(manifest)) problems.push('manifest: the build is debuggable');
  return problems;
}

function configProblems(text: string): string[] {
  let c: Record<string, unknown>;
  try {
    c = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return ['config: capacitor.config.json is not readable JSON'];
  }
  const problems: string[] = [];
  const server = (c.server ?? {}) as Record<string, unknown>;
  const android = (c.android ?? {}) as Record<string, unknown>;
  if (c.appId !== APP_ID) problems.push(`config: appId is not ${APP_ID}`);
  if (server.androidScheme !== 'https') problems.push('config: server.androidScheme is not https');
  if (server.hostname !== 'localhost') problems.push('config: server.hostname is not localhost');
  if (server.url !== undefined) problems.push('config: a server url is set');
  if (server.cleartext === true) problems.push('config: cleartext is allowed');
  if (android.webContentsDebuggingEnabled !== false) problems.push('config: android.webContentsDebuggingEnabled is not false');
  const logging = [c.loggingBehavior, android.loggingBehavior].filter(v => v !== undefined);
  if (logging.length === 0) problems.push('config: no loggingBehavior is set');
  if (logging.some(v => v !== 'none')) problems.push('config: loggingBehavior is not none');
  if (android.allowMixedContent === true) problems.push('config: mixed content is allowed');
  return problems;
}

function assetProblems(apk: ApkView): string[] {
  const problems = releaseProblems(apk.publicFiles).map(p => `assets/public/${p}`);
  const synced = [...apk.publicFiles.keys()].sort();
  const packed = [...apk.apkPublicList].sort();
  if (synced.join('\n') !== packed.join('\n')) problems.push(`assets/public: the APK carries ${packed.length} file(s), ${synced.length} were synced`);
  return problems;
}

function readPublic(dir: string): Map<string, string> {
  const files = new Map<string, string>();
  const walk = (at: string) => {
    for (const name of readdirSync(at)) {
      const p = join(at, name);
      if (statSync(p).isDirectory()) walk(p);
      else files.set(relative(dir, p).split(sep).join('/'), TEXT.has(extname(name)) ? readFileSync(p, 'utf8') : '');
    }
  };
  walk(dir);
  return files;
}

/** One apkanalyzer command; a .bat can't be spawned without a shell, so the command is one fixed string. */
function apkanalyzer(args: string, env: Record<string, string>, tool: string): string {
  const r = spawnSync(`"${tool}" ${args} "${UNSIGNED_APK}"`, { shell: true, encoding: 'utf8', env, windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`apkanalyzer ${args.split(' ')[0] ?? ''} failed (exit ${r.status ?? 'none'})`);
  return r.stdout;
}

if (import.meta.main) {
  const tc = toolchain(process.env);
  const env = childEnv(tc, process.env);
  const tool = toolPaths(tc).apkanalyzer;
  const prefix = '/assets/public/';
  const apkPublicList = apkanalyzer('files list', env, tool).split(/\r?\n/).map(l => l.trim())
    .filter(l => l.startsWith(prefix) && !l.endsWith('/')).map(l => l.slice(prefix.length));
  const problems = apkProblems({
    manifest: apkanalyzer('manifest print', env, tool),
    config: apkanalyzer('files cat --file /assets/capacitor.config.json', env, tool),
    publicFiles: readPublic(PUBLIC_DIR),
    apkPublicList,
  });
  for (const p of problems) console.log(p);
  console.log(problems.length ? `apk check: ${problems.length} problem(s)` : 'apk check: clean');
  process.exitCode = problems.length ? 1 : 0;
}
