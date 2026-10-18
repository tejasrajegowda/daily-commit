import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { driver } from '../../scripts/android/drive.ts';
import { frontOf, guardedPhone, hierarchyOf, NotInApp, oursOnly, phoneTarget, Refused, shellKind, type Adb } from '../../scripts/android/checks/guard.ts';
import { answerOf, askedTwice, codeOnScreen, keyboardName, lockOn, msList, screenOf, storageAnswer, timingsAfter, timingsOf } from '../../scripts/android/checks/p.ts';
import { owner, parseArgs } from '../../scripts/android/checks/sitting.ts';
import { inputTextArg, nodesOf, type UiNode } from '../../scripts/android/drive.ts';

const OURS = 'mCurrentFocus=Window{1a2b u0 app.dailycommit/app.dailycommit.MainActivity}';
const OTHER = 'mCurrentFocus=Window{3c4d u0 com.example.notes/com.example.notes.EditActivity}';
const PROMPT = 'mCurrentFocus=Window{5e6f u0 BiometricPrompt}';

const DUMP = `UI hierchary dumped to: /dev/tty<?xml version='1.0' encoding='UTF-8' standalone='yes' ?><hierarchy rotation="0">
<node index="0" text="" resource-id="" class="android.widget.FrameLayout" package="app.dailycommit" content-desc="" enabled="true" bounds="[0,0][1080,2400]">
<node index="1" text="Today" resource-id="" class="android.widget.Button" package="app.dailycommit" content-desc="" enabled="true" bounds="[0,2200][270,2400]" />
</node>
<node index="2" text="OTHER-APP-WORDS" resource-id="" class="android.widget.TextView" package="com.android.systemui" content-desc="a notification" enabled="true" bounds="[0,0][1080,200]" />
<node index="3" text="NO-PACKAGE-WORDS" resource-id="" class="android.widget.TextView" content-desc="" enabled="true" bounds="[0,300][1080,400]" />
</hierarchy>`;

/** A fake adb: the focus line it answers with, and every command it was sent. */
function fakeAdb(focus: () => string): { adb: Adb; sent: string[][] } {
  const sent: string[][] = [];
  const adb: Adb = args => {
    sent.push([...args]);
    const joined = args.join(' ');
    if (joined.includes('mCurrentFocus')) return { code: 0, out: `  ${focus()}\n` };
    if (joined.includes('uiautomator dump')) return { code: 0, out: DUMP };
    if (joined.includes('wm size')) return { code: 0, out: 'Physical size: 1080x2400' };
    return { code: 0, out: '' };
  };
  return { adb, sent };
}

// The focus line and the screen's size are asked for freely; neither reads anything of an app.
const commands = (sent: readonly string[][]) => sent.map(a => a.join(' ')).filter(c => !c.includes('mCurrentFocus') && !c.endsWith('wm size'));

test('the focus line decides who is in front; a look-alike package is not the app', () => {
  assert.equal(frontOf(OURS), 'app');
  assert.equal(frontOf(OTHER), 'other');
  assert.equal(frontOf(PROMPT), 'prompt');
  assert.equal(frontOf('mCurrentFocus=null'), 'other');
  assert.equal(frontOf(''), 'other');
  assert.equal(frontOf('mCurrentFocus=Window{9 u0 app.dailycommitx/app.dailycommitx.Main}'), 'other');
});

test('with another app in front, no screen is read and nothing is tapped or typed', () => {
  const { adb, sent } = fakeAdb(() => OTHER);
  const io = guardedPhone('R5CT000TEST', adb);
  assert.throws(() => io.dump(), NotInApp);
  assert.throws(() => io.shell('input tap 10 10'), NotInApp);
  assert.throws(() => io.shell('input text CANARY'), NotInApp);
  assert.throws(() => io.shell('input keyevent KEYCODE_ENTER'), NotInApp);
  assert.throws(() => io.shell('input keyevent KEYCODE_BACK'), NotInApp);
  const phone = driver(io);
  assert.throws(() => phone.dump(), NotInApp);
  assert.throws(() => phone.tap('Today', 1_000), NotInApp);
  assert.deepEqual(commands(sent), []);                                          // only focus lines were asked for
});

test('Android\'s own prompt allows only Back; leaving and launching our own app work from anywhere', () => {
  const { adb, sent } = fakeAdb(() => PROMPT);
  const io = guardedPhone('R5CT000TEST', adb);
  assert.throws(() => io.dump(), NotInApp);
  assert.throws(() => io.shell('input tap 10 10'), NotInApp);
  io.shell('input keyevent KEYCODE_BACK');
  io.shell('input keyevent KEYCODE_HOME');
  io.shell('am start -n app.dailycommit/.MainActivity');
  assert.deepEqual(commands(sent), [
    '-s R5CT000TEST shell input keyevent KEYCODE_BACK',
    '-s R5CT000TEST shell input keyevent KEYCODE_HOME',
    '-s R5CT000TEST shell am start -n app.dailycommit/.MainActivity',
  ]);
});

test('a dump keeps only Daily Commit\'s nodes and none of its xml', () => {
  const { adb } = fakeAdb(() => OURS);
  const got = guardedPhone('R5CT000TEST', adb).dump();
  assert.ok(got);
  assert.equal(got.xml, '');
  assert.deepEqual(got.nodes.map(n => n.text), ['', 'Today']);
  assert.ok(got.nodes.every(n => n.pkg === 'app.dailycommit'));
  const all = nodesOf(hierarchyOf(DUMP));
  assert.equal(all.length, 4);
  assert.deepEqual(oursOnly(all).map(n => n.text), ['', 'Today']);
  assert.equal(hierarchyOf('ERROR: could not get idle state.'), '');
});

test('an emulator is never the phone; the dry run takes emulator-5556 only', () => {
  const { adb, sent } = fakeAdb(() => OURS);
  assert.throws(() => guardedPhone('emulator-5554', adb), Refused);
  assert.throws(() => guardedPhone('emulator-5556', adb), Refused);
  assert.throws(() => guardedPhone('emulator-5554', adb, { dryRun: true }), Refused);
  assert.throws(() => guardedPhone('R5CT000TEST', adb, { dryRun: true }), Refused);
  assert.equal(guardedPhone('emulator-5556', adb, { dryRun: true }).serial, 'emulator-5556');
  assert.deepEqual(sent, []);
  assert.deepEqual(phoneTarget('List of devices attached\nemulator-5554\tdevice\nemulator-5556\tdevice\n'), {
    ok: false, why: 'No phone is attached with USB debugging allowed. Nothing was run.',
  });
  assert.deepEqual(phoneTarget('List of devices attached\nemulator-5554\tdevice\nR5CT000TEST\tdevice\n'), { ok: true, serial: 'R5CT000TEST' });
  assert.equal(phoneTarget('List of devices attached\nR5CT000TEST\tunauthorized\n').ok, false);
  assert.equal(phoneTarget('List of devices attached\nR5CT000TEST\tdevice\nR5CT000TWO\tdevice\n').ok, false);
});

test('a screenshot, a recording, other apps, a wipe or an uninstall are refused and never sent', () => {
  const { adb, sent } = fakeAdb(() => OURS);
  const io = guardedPhone('R5CT000TEST', adb);
  for (const c of [
    'screencap -p /sdcard/s.png', 'screenrecord /sdcard/r.mp4', 'pm list packages', 'content query --uri content://contacts',
    'pm clear app.dailycommit', 'pm uninstall app.dailycommit', 'am start -n com.example.notes/.Main',
    'monkey -p com.example.notes 1', 'dumpsys notification --noredact', 'logcat -d', 'logcat -c', 'cat /sdcard/x',
    'rm -f /sdcard/Download/dc-3year.dcbak', 'input text a;screencap', 'settings put secure x 1',
  ]) {
    assert.equal(shellKind(c), 'refused', c);
    assert.throws(() => io.shell(c), Refused, c);
  }
  assert.throws(() => io.execOut(['screencap']), Refused);
  assert.throws(() => io.finger(), Refused);
  assert.deepEqual(sent, []);
});

test('the guard\'s list: what acts in the app, what may run anywhere, what only reads', () => {
  assert.equal(shellKind('input tap 540 1200'), 'in-app');
  assert.equal(shellKind('input text CANARY%styped'), 'in-app');
  assert.equal(shellKind(`input text ${inputTextArg("it's (fine); ok")}`), 'in-app');
  assert.equal(shellKind('input text a&&reboot'), 'refused');
  assert.equal(shellKind('input keyevent KEYCODE_1'), 'in-app');
  assert.equal(shellKind('input keyevent KEYCODE_SLEEP'), 'anywhere');
  assert.equal(shellKind('setprop log.tag.DailyCommit VERBOSE'), 'anywhere');
  assert.equal(shellKind('am force-stop app.dailycommit'), 'anywhere');
  assert.equal(shellKind('logcat -d -v threadtime -s DailyCommit:V'), 'read');
  assert.equal(shellKind('settings get secure default_input_method'), 'read');
});

test('only the keys the steps press are sent: a screenshot key or a key that opens another app is refused', () => {
  for (const k of ['KEYCODE_SYSRQ', '120', 'KEYCODE_CONTACTS', 'KEYCODE_CALL', 'KEYCODE_EXPLORER', 'KEYCODE_ASSIST',
    'KEYCODE_SETTINGS', 'KEYCODE_APP_SWITCH', 'KEYCODE_POWER', 'KEYCODE_NOTIFICATION']) {
    assert.equal(shellKind(`input keyevent ${k}`), 'refused', k);
  }
  assert.equal(shellKind('input keyevent KEYCODE_ENTER'), 'in-app');
  assert.equal(shellKind('input keyevent KEYCODE_BACK'), 'in-app-or-prompt');
  assert.equal(shellKind('input keyevent KEYCODE_HOME'), 'anywhere');
});

test('the phone\'s serial never comes back in adb\'s output, so an error line can\'t carry it', () => {
  const adb: Adb = args => (args.join(' ').includes('mCurrentFocus')
    ? { code: 0, out: OURS }
    : { code: 1, out: "adb: device 'R5CT000TEST' not found" });
  const r = guardedPhone('R5CT000TEST', adb).shell('input keyevent KEYCODE_ENTER');
  assert.equal(r.code, 1);
  assert.doesNotMatch(r.out, /R5CT000TEST/);
});

test('an OWNER step prints one plain line and gives up when its wait runs out', () => {
  const said: string[] = [];
  const o = owner(line => said.push(line), 'answers-that-do-not-exist.txt', 0);
  assert.equal(o.wait('Touch the sensor.', () => false), false);
  assert.equal(o.ask('P6.screenshot', 'Did Android refuse the screenshot?'), 'not done');
  assert.equal(said.filter(l => l.startsWith('OWNER: ')).length, 2);
  assert.deepEqual(said.filter(l => !l.startsWith('OWNER: ')), ['  not done in time', '  not done in time']);
});

test('the owner\'s answers file: key=yes or key=no, the last line wins', () => {
  const text = '# comment\nP6.screenshot=yes\nP6.recents = no\nP6.screenshot=N\nP7.diaryWord=maybe\n';
  assert.equal(answerOf(text, 'P6.screenshot'), 'no');
  assert.equal(answerOf(text, 'P6.recents'), 'no');
  assert.equal(answerOf(text, 'P7.diaryWord'), undefined);
  assert.equal(answerOf(text, 'P6.blinkIcon'), undefined);
});

test('timing lines: only the app\'s three labels, and only after the mark', () => {
  const log = [
    '--------- beginning of main',
    '10-18 01:10:00.100  4242  4242 V DailyCommit: unlock 812 ms',
    '10-18 01:10:05.200  4242  4242 V DailyCommit: something else 9 ms',
    '10-18 01:11:00.300  4242  4242 V DailyCommit: lookback 140 ms',
    '10-18 01:12:00.400  4242  4242 V DailyCommit: restore 2310 ms',
  ].join('\n');
  const all = timingsOf(log);
  assert.deepEqual(all.map(t => `${t.label} ${t.ms}`), ['unlock 812', 'lookback 140', 'restore 2310']);
  assert.deepEqual(timingsAfter(all, '10-18 01:10:00.100').map(t => t.label), ['lookback', 'restore']);
  assert.deepEqual(timingsAfter(all, '').length, 3);
});

test('the keyboard is named, never quoted', () => {
  assert.equal(keyboardName('com.samsung.android.honeyboard/.service.HoneyBoardService\n'), 'Samsung Keyboard');
  assert.equal(keyboardName('com.google.android.inputmethod.latin/com.android.inputmethod.latin.LatinIME'), 'Gboard');
  assert.equal(keyboardName('com.example.keys/.Ime'), 'other');
  assert.equal(keyboardName('null'), 'not readable');
});

const node = (text: string, bounds: UiNode['bounds'] = [0, 0, 10, 10]): UiNode => ({ text, desc: '', id: '', cls: 'android.view.View', bounds, enabled: true, pkg: 'app.dailycommit' });

test('the screens, the storage line and the recovery code are read from the app\'s own words', () => {
  assert.equal(screenOf([node('Daily Commit'), node('Begin'), node('Restore from a backup instead')]), 'welcome');
  assert.equal(screenOf([node('Your record came back with this phone'), node('Restore it'), node('Start new instead')]), 'found');
  assert.equal(screenOf([node('Type it back')]), 'first-run');
  assert.equal(screenOf([node('Locked'), node('Today')]), 'lock');
  assert.equal(screenOf([node('Today'), node('Diary')]), 'open');
  assert.equal(lockOn([node('Use your passphrase')]), true);
  assert.equal(storageAnswer([node("kept in the app's own storage. The phone agreed to keep it safe from clean-up when space runs low")]), 'yes');
  assert.equal(storageAnswer([node("kept in the app's own storage. The phone may clear it if space runs very low; the saved copies cover that")]), 'no');
  assert.equal(storageAnswer([node('On this phone')]), undefined);
  const groups = ['ABCDE', 'FGHJK', 'MNPQR', 'STUVW', 'XYZ23', '45678', '9ABCD', 'EFGHJ'];
  const shown = groups.map((g, i) => node(g, [100 + (i % 4) * 200, 500 + Math.floor(i / 4) * 100, 280 + (i % 4) * 200, 580 + Math.floor(i / 4) * 100]));
  shown.push(node('K', [500, 700, 560, 780]));
  assert.equal(codeOnScreen([...shown].reverse()), `${groups.join('')}K`);
  assert.equal(codeOnScreen(shown.slice(0, 8)), undefined);
});

test('the recorded values: timings listed, "asked twice" only with the page and two prompts', () => {
  assert.equal(msList([812, undefined, 790]), '812, not done, 790');
  assert.equal(askedTwice(true, 2), 'yes (page said so yes; prompts counted 2)');
  assert.equal(askedTwice(false, 2).startsWith('no'), true);
  assert.equal(askedTwice(true, 1).startsWith('no'), true);
});

test('the run\'s arguments: a shorter owner wait only in the dry run; nothing else is taken', () => {
  assert.deepEqual(parseArgs([]), { from: 'P3', dryRun: false, ownerWaitMs: 300_000 });
  assert.deepEqual(parseArgs(['--from', 'P5']), { from: 'P5', dryRun: false, ownerWaitMs: 300_000 });
  assert.deepEqual(parseArgs(['--dry-run', '--owner-wait', '20']), { from: 'P3', dryRun: true, ownerWaitMs: 20_000 });
  assert.equal(parseArgs(['--owner-wait', '20']), undefined);
  assert.equal(parseArgs(['--from', 'P9']), undefined);
  assert.equal(parseArgs(['--serial', 'emulator-5554']), undefined);
  assert.equal(parseArgs(['--dry-run', '--owner-wait', '1']), undefined);
});

test('the steps reach the phone only through the guard', () => {
  const steps = readFileSync(new URL('../../scripts/android/checks/p.ts', import.meta.url), 'utf8');
  const guard = readFileSync(new URL('../../scripts/android/checks/guard.ts', import.meta.url), 'utf8');
  const sitting = readFileSync(new URL('../../scripts/android/checks/sitting.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(steps, /adbOnTestPhone|spawnSync|execOut|\.finger\(|screencap|screenrecord|pm list|content query|uninstall|pm clear/);
  assert.doesNotMatch(guard, /spawnSync|pm clear|uninstall|'screencap|'screenrecord/);
  // The dry run clears the test emulator's app data; adbOnTestPhone addresses only emulator-5556.
  assert.deepEqual([...sitting.matchAll(/pm clear/g)].length, 1);
  assert.match(sitting, /adbOnTestPhone\(\['shell', 'pm clear app\.dailycommit'\]/);
  assert.doesNotMatch(sitting, /console\.log\([^)]*serial/);
});
