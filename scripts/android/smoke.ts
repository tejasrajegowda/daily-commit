// The first start on a running Android: signs a copy of the release build with an emulator-only key,
// installs it on the dc- test phone, opens it, and checks that the window is secure, the first screen
// loads from the app's own origin, the reminder channel is silent, badge-free and private, the app is
// alive and nothing is logged. The emulator is stopped afterwards, pass or fail.
// The emulator-only key lives in .local/android/ (ignored) and is never used for the phone.
// Nothing from the screen is printed except whether the title matched.
// node scripts/android/smoke.ts → one PASS/FAIL line per check, exit 1 on any FAIL; a copy in .local/android/.
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { freemem } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { APP_ID, UNSIGNED_APK } from './apk-check.ts';
import { childEnv, toolchain, toolPaths } from './env.ts';
import { adb, SERIAL, startEmulator, stopEmulator } from './emulator.ts';
import { GB, readHeavy } from './memory.ts';

const DIR = join('.local', 'android');
const KEYSTORE = join(DIR, 'emulator-only.jks');
const KEY_INFO = join(DIR, 'emulator-only.json');
const ALIGNED = join(DIR, 'aligned.apk');
const SIGNED = join(DIR, 'app-emulator.apk');
/** The first screen's title with no record yet (src/first-run/FirstRun.tsx, step 1). */
export const FIRST_SCREEN_TITLE = 'Daily Commit';
const UI_DUMP = '/sdcard/dc-ui.xml';
const TITLE_WAIT_MS = 60_000;

/** The app's own window (not another app's, not its splash) must carry the SECURE flag; every one of them. */
export function windowIsSecure(dumpsysWindow: string): boolean {
  const blocks = dumpsysWindow.split(/^(?=\s*Window #\d+ )/m);
  const ours = blocks.filter(b => /^\s*Window #\d+ Window\{[^}]*\s([\w.]+)\//.exec(b)?.[1] === APP_ID);
  if (ours.length === 0) return false;
  return ours.every(b => {
    const flags = /\sfl=([^\n}]*)/.exec(b)?.[1] ?? '';
    return flags.split(/\s+/).includes('SECURE');
  });
}

// Android overwrites an app's own lock-screen setting on a new channel with "no override" (-1000), so each
// notification's own visibility decides (the plugin builds every one PRIVATE); private (0) is accepted too.
const CHANNEL_RULES: readonly (readonly [string, readonly string[], string])[] = [
  ['mImportance', ['2'], 'is not low (2): it could make a sound or peek on screen'],
  ['mShowBadge', ['false'], 'puts a dot on the icon'],
  ['mLockscreenVisibility', ['-1000', '0'], 'lets the lock screen show more than each notification allows'],
  ['mSound', ['null'], 'has a sound'],
  ['mVibrationEnabled', ['false'], 'vibrates'],
  ['mLights', ['false'], 'blinks a light'],
  ['mBypassDnd', ['false'], 'bypasses do not disturb'],
];

/** The reminder channel ('default', the notification plugin's id) as Task 2a made it, never public; one line per problem. */
export function channelProblems(dumpsysNotification: string): string[] {
  const start = dumpsysNotification.indexOf(`AppSettings: ${APP_ID} (`);
  if (start < 0) return [`channel: no notification settings for ${APP_ID}`];
  const rest = dumpsysNotification.slice(start + 1);
  const next = rest.indexOf('AppSettings: ');
  const section = next < 0 ? rest : rest.slice(0, next);
  const channel = [...section.matchAll(/NotificationChannel\{([^}]*)\}/g)].map(m => m[1] ?? '').find(c => /\bmId='default'/.test(c));
  if (channel === undefined) return ['channel: the reminder channel does not exist'];
  const problems: string[] = [];
  for (const [field, want, why] of CHANNEL_RULES) {
    const value = new RegExp(`\\b${field}=([^,]*)`).exec(channel)?.[1]?.trim();
    if (value === undefined) problems.push(`channel: ${field} is not printed`);
    else if (!want.includes(value)) problems.push(`channel: ${field}=${value} ${why}`);
  }
  return problems;
}

function xmlEscape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Loaded only when a node on screen carries exactly the page's own words. */
export function pageLoaded(uiDump: string, expected: string): boolean {
  return uiDump.includes(`text="${xmlEscape(expected)}"`);
}

function stamp(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/** A tool run with its arguments as a list (no shell); its status only. */
function run(tool: string, args: readonly string[], env: Record<string, string>): number {
  return spawnSync(tool, args, { stdio: 'ignore', env, windowsHide: true, timeout: 300_000 }).status ?? 1;
}

/** A .bat tool: it can't be spawned without a shell, so the command is one fixed string of quoted paths. */
function runBat(tool: string, args: readonly string[], env: Record<string, string>): number {
  const line = [tool, ...args].map(a => `"${a}"`).join(' ');
  return spawnSync(line, { shell: true, stdio: 'ignore', env, windowsHide: true, timeout: 300_000 }).status ?? 1;
}

/** The password goes to keytool and apksigner only through a file of the script's own, removed straight after. */
function withPassFile<T>(password: string, use: (path: string) => T): T {
  const path = join(DIR, `pass-${randomBytes(6).toString('hex')}.tmp`);
  writeFileSync(path, password, { mode: 0o600 });
  try {
    return use(path);
  } finally {
    unlinkSync(path);
  }
}

function emulatorKey(keytool: string, env: Record<string, string>): string | undefined {
  if (existsSync(KEYSTORE) && existsSync(KEY_INFO)) {
    return (JSON.parse(readFileSync(KEY_INFO, 'utf8')) as { password?: string }).password;
  }
  if (existsSync(KEYSTORE) || existsSync(KEY_INFO)) return undefined;   // half a key: refuse rather than overwrite
  const password = randomBytes(24).toString('base64url');
  const code = withPassFile(password, file => run(keytool, ['-genkeypair', '-keystore', KEYSTORE, '-alias', 'emu', '-keyalg', 'RSA',
    '-keysize', '3072', '-validity', '365', '-dname', 'CN=emulator only', '-storepass:file', file, '-keypass:file', file], env));
  if (code !== 0) return undefined;
  writeFileSync(KEY_INFO, JSON.stringify({ password }), { mode: 0o600 });
  return password;
}

async function main(): Promise<number> {
  mkdirSync(DIR, { recursive: true });
  const lines: string[] = [];
  const say = (line: string) => { console.log(line); lines.push(line); };
  let failed = 0;
  const check = (name: string, ok: boolean, detail = '') => {
    if (!ok) failed++;
    say(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` (${detail})` : ''}`);
  };

  const tc = toolchain(process.env);
  const env = childEnv(tc, process.env);
  const paths = toolPaths(tc);
  if (!existsSync(UNSIGNED_APK)) {
    say('no release APK; run npm run android:build first');
    return 1;
  }

  // 1–2: the emulator-only key, then an aligned, signed copy
  const password = emulatorKey(paths.keytool, env);
  check('emulator-only key', password !== undefined);
  if (password === undefined) return finish(lines, 1);
  const signedOk = run(paths.zipalign, ['-p', '-f', '4', UNSIGNED_APK, ALIGNED], env) === 0
    && withPassFile(password, file => runBat(paths.apksigner, ['sign', '--ks', KEYSTORE, '--ks-pass', `file:${file}`, '--out', SIGNED, ALIGNED], env)) === 0
    && runBat(paths.apksigner, ['verify', SIGNED], env) === 0;
  check('signed with the emulator-only key and verified', signedOk);
  if (!signedOk) return finish(lines, 1);

  say(`free memory before the emulator: ${(freemem() / GB).toFixed(1)} GB`);
  const onPhone = async () => {
    // 3: the test phone, then the install
    const booted = await startEmulator();
    check('emulator booted', booted);
    if (!booted) return;
    check('installed', adb(['-s', SERIAL, 'install', '-r', SIGNED], 300_000).status === 0);

    // 4: open it
    check('started', adb(['-s', SERIAL, 'shell', 'am', 'start', '-W', '-n', `${APP_ID}/.MainActivity`], 120_000).status === 0);

    // 5: the first screen, read from the accessibility tree (removed at once) until its title is drawn;
    // a software-drawn emulator takes 10-20 s to draw it, so a fixed wait is not enough
    const opened = Date.now();
    let loaded = false;
    while (!loaded && Date.now() - opened < TITLE_WAIT_MS) {
      adb(['-s', SERIAL, 'shell', 'uiautomator', 'dump', UI_DUMP]);
      loaded = pageLoaded(adb(['-s', SERIAL, 'shell', 'cat', UI_DUMP]).out, FIRST_SCREEN_TITLE);
      adb(['-s', SERIAL, 'shell', 'rm', UI_DUMP]);
      if (!loaded) await sleep(3_000);
    }
    const took = `${((Date.now() - opened) / 1000).toFixed(0)} s`;
    check('first screen loaded from https://localhost (title matched)', loaded, loaded ? took : `not within ${took}`);

    // 6: the window
    check('window is secure', windowIsSecure(adb(['-s', SERIAL, 'shell', 'dumpsys', 'window', 'windows']).out));

    // 7: the reminder channel
    const channel = channelProblems(adb(['-s', SERIAL, 'shell', 'dumpsys', 'notification', '--noredact']).out);
    check('reminder channel is silent, badge-free and private', channel.length === 0, channel.join('; '));

    // 8: alive, and nothing logged under the app's or Capacitor's tags
    check('app is alive', /^\d+/.test(adb(['-s', SERIAL, 'shell', 'pidof', APP_ID]).out.trim()));
    const logged = adb(['-s', SERIAL, 'logcat', '-d', '-s', 'DailyCommit:V', 'Capacitor:V', 'Capacitor/Console:V']).out
      .split(/\r?\n/).filter(l => l.trim() !== '' && !l.startsWith('---------'));
    check('nothing logged', logged.length === 0, logged.length ? `${logged.length} line(s)` : '');
  };
  try {
    await onPhone();
  } finally {
    await stopEmulator();
    const after = readHeavy();
    say(`after: ${after.emulators} emulator(s), ${after.gradleBuilds} Gradle build(s) running; ${(after.freeBytes / GB).toFixed(1)} GB free`);
  }
  say(failed ? `smoke: ${failed} FAIL` : 'smoke: every check PASS');
  return finish(lines, failed ? 1 : 0);
}

function finish(lines: readonly string[], code: number): number {
  const path = join(DIR, `smoke-${stamp(new Date())}.log`);
  writeFileSync(path, `${lines.join('\n')}\n`);
  console.log(`log ${path.split('\\').join('/')}`);
  return code;
}

if (import.meta.main) {
  process.exitCode = await main();
}
