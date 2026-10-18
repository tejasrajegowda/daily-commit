import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { driver, type DeviceIo } from '../../scripts/android/drive.ts';
import { DUMP_COMMAND, frontOf, guardedPhone, hierarchyOf, NOT_FRONT, NotInApp, onlyInFront, oursOnly, phoneTarget, Refused, shellKind, type Adb } from '../../scripts/android/checks/guard.ts';
import { answerOf, askedTwice, codeOnScreen, keyboardName, lockOn, msList, openSettings, runPart, screenOf, storageAnswer, timingsAfter, timingsOf, type ItemKey, type PCtx } from '../../scripts/android/checks/p.ts';
import { owner, parseArgs } from '../../scripts/android/checks/sitting.ts';
import { blinkAnswer, noLearning, plainCard } from '../../scripts/android/checks/standin.ts';
import { adbOnTestPhone, inputTextArg, nodesOf, TEST_SERIAL, type UiNode } from '../../scripts/android/drive.ts';

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

/** A fake adb: the focus line it answers with, and every command it was sent. A guarded command checks the focus as the phone would. */
function fakeAdb(focus: () => string): { adb: Adb; sent: string[][] } {
  const sent: string[][] = [];
  const adb: Adb = args => {
    sent.push([...args]);
    const joined = args.join(' ');
    if (joined.endsWith('grep mCurrentFocus')) return { code: 0, out: `  ${focus()}\n` };
    if (joined.includes('; then ')) {
      const front = frontOf(focus());
      const allowed = front === 'app' || (front === 'prompt' && joined.includes('BiometricPrompt'));
      if (!allowed) return { code: 0, out: `${NOT_FRONT}\n` };
      if (joined.includes('uiautomator dump')) return { code: 0, out: DUMP.slice(DUMP.indexOf('<?xml')) };
      return { code: 0, out: '' };
    }
    if (joined.includes('wm size')) return { code: 0, out: 'Physical size: 1080x2400' };
    return { code: 0, out: '' };
  };
  return { adb, sent };
}

// The focus line and the screen's size are asked for freely; neither reads anything of an app.
const commands = (sent: readonly string[][]) => sent.map(a => a.join(' ')).filter(c => !c.endsWith('grep mCurrentFocus') && !c.endsWith('wm size'));

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
    `-s R5CT000TEST shell ${onlyInFront('input keyevent KEYCODE_BACK', true)}`,
    '-s R5CT000TEST shell input keyevent KEYCODE_HOME',
    '-s R5CT000TEST shell am start -n app.dailycommit/.MainActivity',
  ]);
});

test('every in-app tap, text and key is checked again on the phone in the same call, so a switch in between stops it', () => {
  // The focus moves to another app after the first check: the phone's own check catches it and nothing is done.
  let calls = 0;
  const { adb, sent } = fakeAdb(() => (calls++ === 0 ? OURS : OTHER));
  const io = guardedPhone('R5CT000TEST', adb);
  assert.throws(() => io.shell('input tap 10 10'), NotInApp);
  assert.deepEqual(commands(sent), [`-s R5CT000TEST shell ${onlyInFront('input tap 10 10', false)}`]);
  const check = onlyInFront('input tap 10 10', false);
  assert.match(check, /^if dumpsys window \| grep mCurrentFocus \| head -n 1 \| grep -qE '.+'; then input tap 10 10; else echo DC-NOT-IN-FRONT; fi$/);
  assert.doesNotMatch(check, /BiometricPrompt/);
  assert.match(onlyInFront('input keyevent KEYCODE_BACK', true), /BiometricPrompt/);
  // A screen read too: the focus moved, so no node comes back.
  calls = 0;
  assert.throws(() => io.dump(), NotInApp);
});

test('a screen read goes to a file only the shell can read and is removed in the same call; never /dev/tty or shared storage', () => {
  assert.match(DUMP_COMMAND, /uiautomator dump \/data\/local\/tmp\/dc-ui\.xml >\/dev\/null && cat \/data\/local\/tmp\/dc-ui\.xml; rm -f \/data\/local\/tmp\/dc-ui\.xml/);
  assert.doesNotMatch(DUMP_COMMAND, /\/dev\/tty|\/sdcard/);
  const { adb, sent } = fakeAdb(() => OURS);
  guardedPhone('R5CT000TEST', adb).dump();
  assert.deepEqual(commands(sent), [`-s R5CT000TEST shell ${DUMP_COMMAND}`]);
  // The cat and rm sit inside the guarded read only; on their own they stay refused.
  assert.equal(shellKind('cat /data/local/tmp/dc-ui.xml'), 'refused');
  assert.equal(shellKind('rm -f /data/local/tmp/dc-ui.xml'), 'refused');
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
  const adb: Adb = args => (args.join(' ').endsWith('grep mCurrentFocus')
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

test('the dry run\'s stand-in does the file pick and answers what the emulator measures; on the phone nothing stands in', () => {
  const said: string[] = [];
  const acts: string[] = [];
  let picked = false;
  const o = owner(line => said.push(line), 'answers-that-do-not-exist.txt', 0, {
    act(what) {
      acts.push(what);
      picked = true;
    },
    answer: key => (key === 'P6.screenshot' ? { value: 'yes', how: 'the window is secure' } : undefined),
  });
  assert.equal(o.wait('In Android\'s file picker, choose the file.', () => picked, 'pick-long'), true);
  assert.deepEqual(acts, ['pick-long']);
  assert.equal(o.ask('P6.screenshot', 'Did Android refuse the screenshot?'), 'yes (emulator stand-in: the window is secure)');
  assert.equal(o.ask('P6.recents', 'Does the card show nothing?'), 'not done');
  assert.equal(said.filter(l => l.startsWith('OWNER: ')).length, 3);
  // Without a stand-in (the phone), the act is the owner's alone and the wait simply runs out.
  const plain = owner(() => undefined, 'answers-that-do-not-exist.txt', 0);
  assert.equal(plain.wait('In Android\'s file picker, choose the file.', () => false, 'pick-long'), false);
  // A stand-in that fails says so in one line and the step goes on waiting as usual.
  const lines: string[] = [];
  const broken = owner(line => lines.push(line), 'answers-that-do-not-exist.txt', 0, {
    act() { throw new Error('the file was not in the picker'); },
    answer() { throw new Error('no reading'); },
  });
  assert.equal(broken.wait('pick', () => false, 'pick-long'), false);
  assert.equal(broken.ask('P6.recents', 'q'), 'not done');
  assert.ok(lines.includes('  the stand-in could not: the file was not in the picker'));
  assert.ok(lines.includes('  the stand-in could not: no reading'));
});

test('a failed part records "not done" with its reason for its own items only, and the parts after it still run', () => {
  const got = new Map<string, string>();
  const notes: string[] = [];
  const ctx = {
    record(key: ItemKey, value: string) { got.set(key, value); },
    recorded: (key: ItemKey) => got.has(key),
    note: (line: string) => notes.push(line),
  } as unknown as PCtx;
  runPart(ctx, ['P5.codeMs'], () => { throw new Error('the code was not set'); });
  runPart(ctx, ['P5.lookbackMs'], () => ctx.record('P5.lookbackMs', '120, 130'));
  runPart(ctx, ['P5.fingerSwitchTwice', 'P5.codeFingerMs'], () => {
    ctx.record('P5.fingerSwitchTwice', 'not offered');
    throw new NotInApp();
  });
  assert.equal(got.get('P5.codeMs'), 'not done (the code was not set)');
  assert.equal(got.get('P5.lookbackMs'), '120, 130');
  assert.equal(got.get('P5.fingerSwitchTwice'), 'not offered');
  assert.equal(got.get('P5.codeFingerMs'), 'not done (not in the app)');
  assert.deepEqual(notes, ['P5 stopped: the code was not set', 'P5 not in the app']);
  // A command the guard refused stops the whole run, never only a part.
  assert.throws(() => runPart(ctx, ['P8.kept'], () => { throw new Refused('x'); }), Refused);
});

/** Settings on a phone: the heading, Done and the rows scroll; the dock stays. Swipes move the page; taps are kept. */
function settingsPage(startY: number): { io: DeviceIo; taps: string[] } {
  let y = startY;
  const taps: string[] = [];
  const at = (text: string, top: number, cls = 'android.view.View'): UiNode => ({ text, desc: '', id: '', cls, bounds: [40, top - y, 1040, top - y + 120], enabled: true, pkg: 'app.dailycommit' });
  const dock = (text: string, x: number): UiNode => ({ text, desc: '', id: '', cls: 'android.widget.Button', bounds: [x, 2250, x + 270, 2400], enabled: true, pkg: 'app.dailycommit' });
  const io: DeviceIo = {
    shell(c) {
      if (c === 'wm size') return { code: 0, out: 'Physical size: 1080x2400' };
      const swipe = /^input swipe \d+ (\d+) \d+ (\d+) \d+$/.exec(c);
      if (swipe) y = Math.max(0, Math.min(2600, y + Number(swipe[1]) - Number(swipe[2])));
      const tap = /^input tap (\d+) (\d+)$/.exec(c);
      if (tap) taps.push(`${tap[1]},${tap[2]}`);
      return { code: 0, out: '' };
    },
    execOut() { throw new Error('no'); },
    finger() { throw new Error('no'); },
    dump: () => ({
      xml: '',
      nodes: [at('Settings', 200, 'android.widget.TextView'), at('Done', 200, 'android.widget.Button'), at('Privacy', 1700),
        at("Your phone's lock", 2900), dock('Today', 0), dock('Look back', 270), dock('Diary', 540), dock('Plan', 810)],
    }),
  };
  return { io, taps };
}

test('Settings left scrolled down is scrolled back up, not looked for in the dock', () => {
  const { io, taps } = settingsPage(2400);                     // the heading is far above the screen
  openSettings({ phone: driver(io) } as unknown as PCtx);
  assert.deepEqual(taps, []);                                  // no tap on Plan, none on a heading out of view
  const privacy = io.dump()?.nodes.find(n => n.text === 'Privacy');
  assert.ok(privacy && privacy.bounds[1] >= 0 && privacy.bounds[3] <= 2250);
});

test('a blink is the record on the first screen read after coming back; the lock first is no blink', () => {
  const lock = [node('Locked'), node('Use your passphrase')];
  const open = [node('Today'), node('Diary')];
  assert.equal(blinkAnswer([[], lock, open]), 'no');
  assert.equal(blinkAnswer([[node('Daily Commit')], open]), 'yes');
  assert.equal(blinkAnswer([[], [node('Daily Commit')]]), undefined);
});

/** A raw screencap (12-byte header, RGBA) of w×h filled with `bg`, with `paint` applied per pixel. */
function rawShot(w: number, h: number, paint: (x: number, y: number) => readonly [number, number, number]): Uint8Array {
  const raw = new Uint8Array(12 + w * h * 4);
  const view = new DataView(raw.buffer);
  view.setUint32(0, w, true);
  view.setUint32(4, h, true);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const [r, g, b] = paint(x, y);
      raw.set([r, g, b, 255], 12 + (y * w + x) * 4);
    }
  }
  return raw;
}

test('Recents\' card shows nothing when the middle of the card is one plain colour; lines of text are something', () => {
  // The overview: wallpaper around a plain card in the app's theme colour.
  const plain = rawShot(100, 200, (x, y) => (x > 20 && x < 80 && y > 40 && y < 160 ? [16, 16, 16] : [200, 120, 40]));
  assert.equal(plainCard(plain), true);
  // The same card with rows of words across its middle.
  const words = rawShot(100, 200, (x, y) => (x > 20 && x < 80 && y > 40 && y < 160 ? (y % 9 < 3 && x % 5 < 3 ? [230, 230, 230] : [16, 16, 16]) : [200, 120, 40]));
  assert.equal(plainCard(words), false);
  assert.equal(plainCard(new Uint8Array(4)), undefined);
});

test('the keyboard is told not to learn when the focused field carries noPersonalizedLearning', () => {
  const dump = (opts: string) => `Current Input Method Manager state:\n  mCurMethodId=com.example/.Ime\n  mCurEditorInfo:\n    inputType=0x1 imeOptions=${opts} privateImeOptions=null\n`;
  assert.equal(noLearning(dump('0x1000006')), true);
  assert.equal(noLearning(dump('0x6')), false);
  assert.equal(noLearning('Current Input Method Manager state:\n  mCurEditorInfo: null\n'), undefined);
  // An older editor line further down does not count when the current one is there.
  assert.equal(noLearning(`${dump('0x6')}  history:\n    imeOptions=0x1000006\n`), false);
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
  // The stand-in reaches only the test emulator, and only the dry run makes one.
  const standin = readFileSync(new URL('../../scripts/android/checks/standin.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(standin, /guardedPhone|phoneTarget|spawnSync|'-s'/);
  assert.doesNotMatch(steps, /standin/);
  assert.match(sitting, /owner\(say, answers, args\.ownerWaitMs, args\.dryRun \? dryRunStandIn\(\) : undefined\)/);
  assert.deepEqual([...sitting.matchAll(/dryRunStandIn\(/g)].length, 1);
});

test('the stand-in can reach only the dc- test emulator, and only after the dry run checked its name', () => {
  // Its modules are a fixed list: none of them is a raw adb, the phone's install or the guard's phone.
  const standin = readFileSync(new URL('../../scripts/android/checks/standin.ts', import.meta.url), 'utf8');
  const from = [...standin.matchAll(/^import [^;]* from ['"]([^'"]+)['"];/gm)].map(m => m[1]).sort();
  assert.deepEqual(from, ['../drive.ts', '../smoke.ts', './a.ts', './guard.ts', './p.ts', './screen.ts', 'node:buffer']);
  assert.match(standin, /^import \{ windowIsSecure \} from '\.\.\/smoke\.ts';$/m);
  assert.match(standin, /^import \{ frontOf \} from '\.\/guard\.ts';$/m);
  // Every adb call under it names emulator-5556 and nothing else; another serial is refused before adb runs.
  const drive = readFileSync(new URL('../../scripts/android/drive.ts', import.meta.url), 'utf8');
  assert.equal(TEST_SERIAL, 'emulator-5556');
  const spawns = [...drive.matchAll(/spawnSync\(/g)].length;
  assert.equal(spawns, 2);
  assert.equal([...drive.matchAll(/spawnSync\(adb, \['-s', TEST_SERIAL, \.\.\.args\]/g)].length, spawns);
  assert.throws(() => adbOnTestPhone(['-s', 'R5CT000TEST', 'shell', 'true']), /only emulator-5556/);
  // The dry run refuses an emulator whose AVD isn't dc-, before the stand-in or the guarded io exists.
  const sitting = readFileSync(new URL('../../scripts/android/checks/sitting.ts', import.meta.url), 'utf8');
  assert.match(sitting, /if \(named\.code !== 0 \|\| !isDcTestPhone\(named\.out\)\) \{\s*say\('FAIL emulator-5556 is not a dc- test phone'\);\s*return false;/);
  const checked = sitting.indexOf('if (args.dryRun && !(await prepareDryRun(say))) return 1;');
  assert.ok(checked > 0);
  assert.ok(checked < sitting.indexOf('guardedPhone(serial'));
  assert.ok(checked < sitting.indexOf('dryRunStandIn()'));
});
