import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { APP_ID } from '../../scripts/android/apk-check.ts';
import { adbVerdict, EMULATOR_SERIAL, runAdb, type Lane } from '../../scripts/android/adbGate.ts';
import { captureTo } from '../../scripts/android/checks/b.ts';
import { DRY_RUN_SERIAL } from '../../scripts/android/checks/guard.ts';
import {
  APP, DUMP_COMMAND, FOCUS_READ, LONG_REMOTE, Refused, SCAN_LONG, onlyInFront,
} from '../../scripts/android/checks/shellAllow.ts';
import { inputTextArg, TEST_SERIAL } from '../../scripts/android/drive.ts';
import { SERIAL } from '../../scripts/android/emulator.ts';

const PHONE = 'R5CT000TEST';
const EMU = EMULATOR_SERIAL;
const BAK = '/data/data/app.dailycommit/files/backup/latest.dcbak';
const APK = 'android/app/build/outputs/apk/release/app-release.apk';

function on(serial: string, args: readonly string[]): readonly string[] {
  return ['-s', serial, ...args];
}

interface Row {
  readonly lane: Lane;
  readonly args: readonly string[];
  readonly ok: boolean;
  readonly why?: RegExp;
}

const tap = onlyInFront('input tap 540 1200', false);
const swipe = onlyInFront('input swipe 540 1872 540 768 300', false);
const typed = onlyInFront(`input text ${inputTextArg('CANARY phone test passphrase')}`, false);
const enter = onlyInFront('input keyevent KEYCODE_ENTER', false);
const digit = onlyInFront('input keyevent KEYCODE_1', false);
const back = onlyInFront('input keyevent KEYCODE_BACK', true);
const wrappedCat = onlyInFront(`cat ${BAK}`, false);

const ROWS: readonly Row[] = [
  // The commands the phone sitting actually sends.
  { lane: 'phoneChecks', args: ['devices'], ok: true },
  { lane: 'phoneChecks', args: on(PHONE, ['shell', 'pm path app.dailycommit']), ok: true },
  { lane: 'phoneChecks', args: on(PHONE, ['shell', 'setprop log.tag.DailyCommit ""']), ok: true },
  { lane: 'phoneChecks', args: on(PHONE, ['shell', 'setprop log.tag.DailyCommit VERBOSE']), ok: true },
  { lane: 'phoneChecks', args: on(PHONE, ['shell', 'getprop log.tag.DailyCommit']), ok: true },
  { lane: 'phoneChecks', args: on(PHONE, ['shell', 'wm dismiss-keyguard']), ok: true },
  { lane: 'phoneChecks', args: on(PHONE, ['shell', 'wm size']), ok: true },
  { lane: 'phoneChecks', args: on(PHONE, ['shell', 'logcat -d -v threadtime -s DailyCommit:V']), ok: true },
  { lane: 'phoneChecks', args: on(PHONE, ['shell', 'settings get secure default_input_method']), ok: true },
  { lane: 'phoneChecks', args: on(PHONE, ['shell', 'am force-stop app.dailycommit']), ok: true },
  { lane: 'phoneChecks', args: on(PHONE, ['shell', 'am start -n app.dailycommit/.MainActivity']), ok: true },
  { lane: 'phoneChecks', args: on(PHONE, ['shell', 'am start -W -n app.dailycommit/.MainActivity']), ok: true },
  { lane: 'phoneChecks', args: on(PHONE, ['shell', 'input keyevent KEYCODE_HOME']), ok: true },
  { lane: 'phoneChecks', args: on(PHONE, ['shell', 'input keyevent KEYCODE_WAKEUP']), ok: true },
  { lane: 'phoneChecks', args: on(PHONE, ['shell', 'input keyevent KEYCODE_SLEEP']), ok: true },
  { lane: 'phoneChecks', args: on(PHONE, ['shell', 'date +%s']), ok: true },
  { lane: 'phoneChecks', args: on(PHONE, ['shell', SCAN_LONG]), ok: true },
  { lane: 'phoneChecks', args: on(PHONE, ['shell', FOCUS_READ]), ok: true },
  { lane: 'phoneChecks', args: on(PHONE, ['shell', DUMP_COMMAND]), ok: true },
  { lane: 'phoneChecks', args: on(PHONE, ['shell', tap]), ok: true },
  { lane: 'phoneChecks', args: on(PHONE, ['shell', swipe]), ok: true },
  { lane: 'phoneChecks', args: on(PHONE, ['shell', typed]), ok: true },
  { lane: 'phoneChecks', args: on(PHONE, ['shell', enter]), ok: true },
  { lane: 'phoneChecks', args: on(PHONE, ['shell', digit]), ok: true },
  { lane: 'phoneChecks', args: on(PHONE, ['shell', back]), ok: true },
  { lane: 'phoneChecks', args: on(PHONE, ['push', 'long.dcbak', LONG_REMOTE]), ok: true },
  { lane: 'phoneChecks', args: on(DRY_RUN_SERIAL, ['shell', FOCUS_READ]), ok: true },

  // The install step: list, read the version, install -r.
  { lane: 'install', args: ['devices'], ok: true },
  { lane: 'install', args: on(PHONE, ['shell', 'dumpsys', 'package', APP_ID]), ok: true },
  { lane: 'install', args: on(EMU, ['install', '-r', APK]), ok: true },
  { lane: 'install', args: on(PHONE, ['install', '-r', APK]), ok: true },

  // The emulator lane: the shapes the scripts pass today. -s after the verb stays.
  { lane: 'emulator', args: ['devices'], ok: true },
  { lane: 'emulator', args: on(EMU, ['emu', 'avd', 'name']), ok: true },
  { lane: 'emulator', args: on(EMU, ['emu', 'kill']), ok: true },
  { lane: 'emulator', args: on(EMU, ['emu', 'finger', 'touch', '1']), ok: true },
  { lane: 'emulator', args: on(EMU, ['shell', 'getprop', 'sys.boot_completed']), ok: true },
  { lane: 'emulator', args: on(EMU, ['shell', 'getprop', 'init.svc.bootanim']), ok: true },
  { lane: 'emulator', args: on(EMU, ['shell', 'rm', '-f', '/data/local/tmp/dc-fill', '/data/user/0/app.dailycommit/dc-fill']), ok: true },
  { lane: 'emulator', args: on(EMU, ['shell', 'sync']), ok: true },
  { lane: 'emulator', args: on(EMU, ['shell', 'am', 'start', '-W', '-n', `${APP_ID}/.MainActivity`]), ok: true },
  { lane: 'emulator', args: on(EMU, ['shell', 'uiautomator', 'dump', '/sdcard/dc-ui.xml']), ok: true },
  { lane: 'emulator', args: on(EMU, ['shell', 'cat', '/sdcard/dc-ui.xml']), ok: true },
  { lane: 'emulator', args: on(EMU, ['shell', 'dumpsys', 'window', 'windows']), ok: true },
  { lane: 'emulator', args: on(EMU, ['shell', 'dumpsys', 'notification', '--noredact']), ok: true },
  { lane: 'emulator', args: on(EMU, ['shell', 'dumpsys', 'alarm']), ok: true },
  { lane: 'emulator', args: on(EMU, ['shell', 'pidof', APP_ID]), ok: true },
  { lane: 'emulator', args: on(EMU, ['shell', 'id']), ok: true },
  { lane: 'emulator', args: on(EMU, ['shell', 'pm clear app.dailycommit']), ok: true },
  { lane: 'emulator', args: on(EMU, ['shell', `bmgr backupnow ${APP_ID}`]), ok: true },
  { lane: 'emulator', args: on(EMU, ['shell', 'settings put global airplane_mode_on 0']), ok: true },
  { lane: 'emulator', args: on(EMU, ['uninstall', APP_ID]), ok: true },
  { lane: 'emulator', args: on(EMU, ['install', '-r', APK]), ok: true },
  { lane: 'emulator', args: on(EMU, ['logcat', '-d', '-s', 'DailyCommit:V', 'Capacitor:V', 'Capacitor/Console:V']), ok: true },
  { lane: 'emulator', args: on(EMU, ['logcat', '-d', '-b', 'all']), ok: true },
  { lane: 'emulator', args: on(EMU, ['root']), ok: true },
  { lane: 'emulator', args: on(EMU, ['wait-for-device']), ok: true },
  { lane: 'emulator', args: on(EMU, ['forward', 'tcp:9222', 'localabstract:webview_devtools_remote_1']), ok: true },
  { lane: 'emulator', args: on(EMU, ['forward', '--remove', 'tcp:9222']), ok: true },
  { lane: 'emulator', args: on(EMU, ['exec-out', 'screencap']), ok: true },
  { lane: 'emulator', args: on(EMU, ['exec-out', 'cat', '/data/data/app.dailycommit/files/backup/latest.dcbak']), ok: true },
  { lane: 'emulator', args: on(EMU, ['exec-out', 'tar', '-cf', '-', '/data/data/app.dailycommit']), ok: true },
  { lane: 'emulator', args: on(EMU, ['push', 'seed.dcbak', '/sdcard/Download/dc-seed.dcbak']), ok: true },
  { lane: 'emulator', args: on(EMU, ['shell', 'input', 'tap', '200', '400']), ok: true },

  // Review attacks. Each one is refused on the lane that must not run it.
  { lane: 'install', args: on(PHONE, ['pull', BAK, 'copy.dcbak']), ok: false },
  { lane: 'install', args: on(PHONE, ['backup', '-f', 'copy.ab', APP_ID]), ok: false },
  { lane: 'install', args: on(PHONE, ['restore', 'copy.ab']), ok: false },
  { lane: 'install', args: on(PHONE, ['bugreport', 'out.zip']), ok: false },
  { lane: 'install', args: on(PHONE, ['exec-out', 'cat', BAK]), ok: false },
  { lane: 'install', args: on(PHONE, ['shell', 'cat', BAK]), ok: false },
  { lane: 'install', args: on(PHONE, ['shell', `cat ${BAK}`]), ok: false },
  { lane: 'install', args: on(PHONE, ['uninstall', APP_ID]), ok: false },
  { lane: 'install', args: on(PHONE, ['run-as', APP_ID]), ok: false },
  { lane: 'install', args: on(PHONE, ['logcat', '-d']), ok: false },
  { lane: 'install', args: on(PHONE, ['install', '-r', '-d', APK]), ok: false, why: /-d/ },
  { lane: 'install', args: on(PHONE, ['install', '-d', APK]), ok: false, why: /-d/ },
  { lane: 'install', args: on(PHONE, ['install', '-r']), ok: false },
  { lane: 'install', args: on(PHONE, ['install', '-r', 'notes.txt']), ok: false },
  { lane: 'install', args: on(PHONE, ['install', '-r', 'copy.dcbak']), ok: false },
  { lane: 'install', args: on(PHONE, ['install', '-r', '.apk']), ok: false },
  { lane: 'install', args: on(PHONE, ['shell', 'dumpsys', 'package', 'other.app']), ok: false },
  { lane: 'install', args: on(PHONE, ['-s', EMU, 'pull', BAK, 'copy.dcbak']), ok: false, why: /second -s/ },

  { lane: 'phoneChecks', args: on(PHONE, ['pull', BAK, 'copy.dcbak']), ok: false },
  { lane: 'phoneChecks', args: on(PHONE, ['backup', '-f', 'copy.ab', APP_ID]), ok: false },
  { lane: 'phoneChecks', args: on(PHONE, ['restore', 'copy.ab']), ok: false },
  { lane: 'phoneChecks', args: on(PHONE, ['bugreport']), ok: false },
  { lane: 'phoneChecks', args: on(PHONE, ['exec-out', 'cat', BAK]), ok: false },
  { lane: 'phoneChecks', args: on(PHONE, ['shell', 'cat', BAK]), ok: false, why: /one command/ },
  { lane: 'phoneChecks', args: on(PHONE, ['shell', `cat ${BAK}`]), ok: false, why: /that shell command is refused/ },
  { lane: 'phoneChecks', args: on(PHONE, ['shell', 'input', 'tap', '200', '400']), ok: false, why: /one command/ },
  { lane: 'phoneChecks', args: on(PHONE, ['shell', 'input tap 200 400']), ok: false, why: /that shell command is refused/ },
  { lane: 'phoneChecks', args: on(PHONE, ['shell', wrappedCat]), ok: false, why: /that shell command is refused/ },
  { lane: 'phoneChecks', args: on(PHONE, ['uninstall', APP_ID]), ok: false },
  { lane: 'phoneChecks', args: on(PHONE, ['run-as', APP_ID]), ok: false },
  { lane: 'phoneChecks', args: on(PHONE, ['logcat', '-d', '-s', 'DailyCommit:V']), ok: false },
  { lane: 'phoneChecks', args: on(PHONE, ['push', 'long.dcbak', BAK]), ok: false, why: /invented file/ },
  { lane: 'phoneChecks', args: on(PHONE, ['push', 'long.dcbak', '/sdcard/Download/other.dcbak']), ok: false, why: /invented file/ },
  { lane: 'phoneChecks', args: on(PHONE, ['-s', PHONE, 'pull', 'a', 'b']), ok: false, why: /second -s/ },
  { lane: 'install', args: on(PHONE, ['shell', 'input tap 200 400']), ok: false },

  { lane: 'emulator', args: ['shell', 'cat', BAK], ok: false, why: /-s before the verb/ },
  { lane: 'emulator', args: on(PHONE, ['shell', 'input', 'tap', '200', '400']), ok: false, why: /only emulator-5556/ },
  { lane: 'emulator', args: on(PHONE, ['pull', BAK, 'copy.dcbak']), ok: false, why: /only emulator-5556/ },
  { lane: 'emulator', args: on(EMU, ['-s', PHONE, 'shell', 'true']), ok: false, why: /only emulator-5556/ },
  { lane: 'emulator', args: on(EMU, ['-s', EMU, 'shell', 'true']), ok: false, why: /only emulator-5556/ },
  { lane: 'phoneChecks', args: ['shell', 'echo hi'], ok: false, why: /-s before the verb/ },
  { lane: 'install', args: ['-s'], ok: false, why: /serial is missing/ },
  { lane: 'emulator', args: on(EMU, []), ok: false, why: /no verb/ },
];

test('the serial constants are the test emulator', () => {
  assert.equal(APP, APP_ID);
  assert.equal(EMULATOR_SERIAL, 'emulator-5556');
  assert.equal(SERIAL, EMULATOR_SERIAL);
  assert.equal(TEST_SERIAL, EMULATOR_SERIAL);
  assert.equal(DRY_RUN_SERIAL, EMULATOR_SERIAL);
});

test('adbVerdict allows the commands the scripts send and refuses every review attack', () => {
  const problems: string[] = [];
  for (const row of ROWS) {
    const verdict = adbVerdict(row.lane, row.args);
    const shown = `${row.lane} ${row.args.join(' ').slice(0, 140)}`;
    if (verdict.ok !== row.ok) problems.push(`${shown} → ${JSON.stringify(verdict)}`);
    else if (!verdict.ok && row.why !== undefined && !row.why.test(verdict.why)) {
      problems.push(`${shown} → ${verdict.why}`);
    }
  }
  assert.deepEqual(problems, []);
});

test('a refused command throws before anything is spawned', () => {
  let spawned = false;
  assert.throws(
    () => runAdb('install', on(PHONE, ['pull', BAK, 'copy.dcbak']), {
      spawn: () => { spawned = true; return { status: 0 }; },
    }),
    (err: unknown) => err instanceof Refused && err.message.startsWith('refused:'),
  );
  assert.equal(spawned, false);
});

test('a renamed callee is still refused before anything is spawned', () => {
  let spawned = false;
  const send = runAdb;
  assert.throws(
    () => send('install', ['-s', 'X', 'pull', 'a', 'b'], {
      spawn: () => { spawned = true; return { status: 0 }; },
    }),
    (err: unknown) => err instanceof Refused,
  );
  assert.equal(spawned, false);
});

test('a refused capture throws before the file is opened', () => {
  const dest = join(tmpdir(), `dc-adb-gate-${process.pid}.bin`);
  let spawned = false;
  assert.throws(
    () => runAdb('emulator', on(PHONE, ['shell', 'true']), {
      captureTo: dest,
      spawn: () => { spawned = true; return { status: 0 }; },
    }),
    /only emulator-5556/,
  );
  assert.equal(spawned, false);
  assert.equal(existsSync(dest), false);
  assert.throws(() => captureTo(['-s', 'X', 'shell', 'true'], dest, 1_000), /only emulator-5556/);
  assert.equal(existsSync(dest), false);
});

test('proc.ts refuses adb at run time, so the gate is the only way to a device', async () => {
  const { refusesAdbFile, refusesAdbCommand, runSync, runSyncCommand, startChild, NOT_THROUGH_GATE } = await import('../../scripts/android/proc.ts');
  for (const f of ['adb', 'ADB.EXE', String.raw`C:\sdk\platform-tools\adb.exe`, '/sdk/platform-tools/adb', String.raw`"C:\sdk\platform-tools\adb.exe"`]) assert.equal(refusesAdbFile(f), true, f);
  for (const f of ['apksigner.bat', String.raw`C:\sdk\build-tools\36.0.0\apkanalyzer.bat`, 'npm', 'node', 'keytool', 'emulator']) assert.equal(refusesAdbFile(f), false, f);
  assert.equal(refusesAdbCommand(String.raw`"C:\sdk\platform-tools\adb.exe" -s X pull /a b`), true);
  assert.equal(refusesAdbCommand('adb shell cat /a'), true);
  assert.equal(refusesAdbCommand(String.raw`"C:\sdk\build-tools\36.0.0\apksigner.bat" verify --print-certs "app.apk"`), false);
  assert.throws(() => runSync(String.raw`C:\sdk\platform-tools\adb.exe`, ['-s', 'X', 'pull', '/a', 'b'], {}), new RegExp(NOT_THROUGH_GATE));
  assert.throws(() => runSyncCommand('adb -s X backup -f c.ab app', { shell: true }), new RegExp(NOT_THROUGH_GATE));
  assert.throws(() => startChild('adb', ['-s', 'X', 'shell', 'cat', '/a'], {}), new RegExp(NOT_THROUGH_GATE));
  // adb handed to another program as an argument (review 3)
  assert.throws(() => runSync('powershell', ['-NoProfile', '-Command', 'adb -s X pull /a b'], {}), new RegExp(NOT_THROUGH_GATE));
  assert.throws(() => runSync('cmd.exe', ['/c', String.raw`C:\sdk\platform-tools\adb.exe`, '-s', 'X', 'pull', '/a', 'b'], {}), new RegExp(NOT_THROUGH_GATE));
  assert.throws(() => runSync('adb pull /a b', [], { shell: true }), new RegExp(NOT_THROUGH_GATE));
  assert.throws(() => startChild('powershell', ['-Command', '& "adb.exe" backup -f c.ab app'], {}), new RegExp(NOT_THROUGH_GATE));
  assert.throws(() => runSyncCommand('powershell -Command "(adb) shell cat /a"', { shell: true }), new RegExp(NOT_THROUGH_GATE));
  // a powershell block with no space, and the other extensions Windows runs (review 4)
  assert.throws(() => runSyncCommand('powershell -Command "&{adb pull /a b}"', { shell: true }), new RegExp(NOT_THROUGH_GATE));
  assert.throws(() => runSyncCommand('powershell -Command "&{adb}"', { shell: true }), new RegExp(NOT_THROUGH_GATE));
  for (const f of ['adb.cmd', 'ADB.BAT', 'adb.com', String.raw`C:\tools\adb.cmd`]) assert.equal(refusesAdbFile(f), true, f);
  // the tools the scripts do start are not refused
  for (const [file, args] of [['powershell', ['-NoProfile', '-Command', "Get-CimInstance Win32_Process -Filter \"Name='java.exe'\""]], ['keytool', ['-list', '-v']], ['java', ['-jar', 'gradle-wrapper.jar', '--no-daemon']], ['npm', ['run', 'phone', '--', '--serial', 'emulator-5556']]] as const) {
    assert.equal(refusesAdbFile(file) || (args as readonly string[]).some(a => refusesAdbCommand(a)), false, `${file} ${args.join(' ')}`);
  }
});
