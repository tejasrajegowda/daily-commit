import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { availKb, credentialAction, fingerStep, focusIsCredential, pastLock, recentsPicture, recordOpened, sensorBeforePin, timingStep } from '../../scripts/android/checks/a.ts';
import { forbiddenCanary, passphraseOnlyScreen, readSearched, recoveryCodeReady, rootStep, snapshotNames } from '../../scripts/android/checks/b.ts';
import { isBlackRaw, secureCapture } from '../../scripts/android/checks/screen.ts';
import { devtoolsOnImage, devtoolsSocket, ourAlarms, ourNotifications, ourTaskId, resumedActivity } from '../../scripts/android/checks/dumps.ts';
import type { UiNode } from '../../scripts/android/drive.ts';

const node = (text: string): UiNode => ({ text, desc: '', id: '', cls: 'android.widget.Button', bounds: [0, 0, 10, 10], enabled: true });

const raw = (w: number, h: number, header: 12 | 16, paint?: number) => {
  const b = new Uint8Array(header + w * h * 4);
  new DataView(b.buffer).setUint32(0, w, true);
  new DataView(b.buffer).setUint32(4, h, true);
  for (let i = header + 3; i < b.length; i += 4) b[i] = 255;                    // opaque black
  if (paint !== undefined) b[header + paint * 4] = 40;                         // one pixel not black
  return b;
};

test('a raw screencap is black only if every pixel is, with either header size', () => {
  assert.equal(isBlackRaw(raw(4, 3, 12)), true);
  assert.equal(isBlackRaw(raw(4, 3, 16)), true);
  assert.equal(isBlackRaw(raw(4, 3, 16, 7)), false);
  assert.throws(() => isBlackRaw(new Uint8Array(20)));
});

test('a secure capture is black, or only the system bars are not', () => {
  assert.equal(secureCapture(raw(4, 8, 16)), 'black');
  const bars = raw(4, 8, 16);
  bars[16] = 255;
  bars[16 + (4 * 8 - 1) * 4] = 255;
  assert.equal(secureCapture(bars), 'bars');
  assert.equal(secureCapture(raw(4, 8, 16, 16)), 'shown');
});

// Invented dumps in the shape of API 33's. Before these readers are trusted, compare them with one
// real dump each from the run's first check, and fix the fixture to match; never loosen a reader.
test('our posted notifications: title and text, ours only', () => {
  const dump = `  NotificationRecord(0x0a1b: pkg=app.dailycommit user=UserHandle{0} id=29460120 tag=null importance=2 key=0|app.dailycommit|29460120|null|10190: Notification(channel=default ...))
        extras={
          android.title=String (Daily Commit)
          android.text=String (Walk)
        }
    NotificationRecord(0x0c2d: pkg=app.dailycommit user=UserHandle{0} id=29460121 tag=null importance=2 key=0|app.dailycommit|29460121|null|10190: Notification(channel=default ...))
        extras={
          android.title=String (Daily Commit)
        }
    NotificationRecord(0x0e3f: pkg=com.other user=UserHandle{0} id=1 ...)
        extras={
          android.title=String (Other)
        }`;
  assert.deepEqual(ourNotifications(dump), [{ title: 'Daily Commit', text: 'Walk' }, { title: 'Daily Commit', text: '' }]);
});

test('our alarms, and whether each is exact', () => {
  const dump = `  RTC_WAKEUP #1: Alarm{1a2b type 0 origWhen 1767607200000 app.dailycommit}
      tag=*walarm*:app.dailycommit/com.capacitorjs.plugins.localnotifications.TimedNotificationPublisher
      type=RTC_WAKEUP origWhen=2026-01-05 10:00:00.000 window=0 exactAllowReason=permission repeatInterval=0 count=0 flags=0x9
    RTC_WAKEUP #2: Alarm{3c4d type 0 origWhen 1767610800000 app.dailycommit}
      type=RTC_WAKEUP origWhen=2026-01-05 11:00:00.000 window=+1h0m0s0ms repeatInterval=0 count=0 flags=0x8
    RTC #3: Alarm{5e6f type 1 origWhen 1767610800000 com.other}
      type=RTC window=0`;
  assert.deepEqual(ourAlarms(dump), [{ exact: true }, { exact: false }]);
});

test('no devtools socket; the resumed activity; our task in recents', () => {
  assert.equal(devtoolsSocket('0000: 00000002 00000000 00010000 0001 01 1234 @chrome_devtools_remote\n'), false);
  assert.equal(devtoolsSocket('0000: 00000002 00000000 00010000 0001 01 1234 @webview_devtools_remote_4321\n'), true);
  assert.equal(devtoolsOnImage('userdebug', true), 'debug-image');
  assert.equal(devtoolsOnImage('eng', true), 'debug-image');
  assert.equal(devtoolsOnImage('user', true), 'open');
  assert.equal(devtoolsOnImage('userdebug', false), 'closed');
  assert.equal(resumedActivity('  mResumedActivity: ActivityRecord{1a u0 app.dailycommit/.MainActivity t12}\n'), 'app.dailycommit/.MainActivity');
  assert.equal(ourTaskId('  * Recent #0: Task{2b #12 type=standard A=10190:app.dailycommit U=0 visible=false}\n'), 12);
});

test('df available is the number before the percent, not a digit inside the device name', () => {
  const obb = 'Filesystem       1K-blocks   Used Available Use% Mounted on\n/dev/block/dm-34  10167132 783904   9383228   8% /storage/emulated/0/Android/obb\n';
  assert.equal(availKb(obb), 9383228);
  const data = 'Filesystem     1K-blocks    Used Available Use% Mounted on\n/dev/block/dm-5   6082144 2345678   3602144  40% /data\n';
  assert.equal(availKb(data), 3602144);
});

test('an opened record is Today, the dock, or the reminder ask, and the lock screen is not', () => {
  assert.equal(recordOpened([node('Locked'), node('Passphrase'), node('Open')]), false);
  assert.equal(recordOpened([node('Let Daily Commit send reminders'), node('Not now')]), true);
  assert.equal(recordOpened([node('Today'), node('Walk')]), true);
  assert.equal(recordOpened([node('Plan')]), true);
});

test('a snapshot file for our task fails the recents check, and another task does not', () => {
  assert.equal(recentsPicture('', 7), undefined);
  assert.equal(recentsPicture('-rw-rw---- 1 system system 12 8.jpg\n', 7), undefined);
  assert.match(recentsPicture('-rw-rw---- 1 system system 12 7.jpg\n', 7) ?? '', /1 snapshot file/);
  assert.match(recentsPicture('7.jpg\n7_reduced.jpg\n', 7) ?? '', /2 snapshot file/);
});

test('an open record still on the lock screen is not past the lock', () => {
  assert.equal(pastLock([node('Locked'), node('Today'), node('Open')]), false);
  assert.equal(pastLock([node('Today'), node('Walk')]), true);
  assert.equal(pastLock([node('Locked'), node('Passphrase'), node('Open')]), false);
});

test('the timing sample is taken on the lock screen, and an open record is locked first', () => {
  assert.equal(timingStep(false, true), 'measure');
  assert.equal(timingStep(true, true), 'lock');
  assert.equal(timingStep(true, false), 'lock');
  assert.equal(timingStep(false, false), 'wait');
});

test('a fingerprint touch waits for the prompt, then stops after eight', () => {
  assert.equal(fingerStep(true, true, 0), 'done');
  assert.equal(fingerStep(false, false, 0), 'wait');
  assert.equal(fingerStep(false, true, 0), 'touch');
  assert.equal(fingerStep(false, true, 7), 'touch');
  assert.equal(fingerStep(false, true, 8), 'wait');
});

test('a credential window counts only while it is the focused one', () => {
  const back = 'mCurrentFocus=Window{abc u0 com.android.settings/com.android.settings.biometrics.fingerprint.FingerprintEnrollIntroduction}\n'
    + 'ActivityRecord{x u0 com.android.settings.password.ConfirmLockPassword t12}';
  const pin = 'mCurrentFocus=Window{abc u0 com.android.settings.password.ConfirmLockPassword}';
  assert.equal(focusIsCredential(back), false);
  assert.equal(focusIsCredential(pin), true);
});

test('the fingerprint sensor is touched before Use PIN when both are on the prompt', () => {
  assert.equal(sensorBeforePin(['Tap to cancel authentication', 'Daily Commit', 'Touch the fingerprint sensor', 'Use PIN']), true);
  assert.equal(sensorBeforePin(['Tap to cancel authentication', 'Daily Commit']), false);
});

test('a credential prompt with Use PIN is typed; a sensor with no PIN is touched', () => {
  assert.equal(credentialAction(['Tap to cancel authentication', 'Daily Commit', 'Touch the fingerprint sensor', 'Use PIN']), 'use-pin');
  assert.equal(credentialAction(['Touch the fingerprint sensor', 'Daily Commit']), 'finger');
  assert.equal(credentialAction(['Tap to cancel authentication', 'Daily Commit']), 'type');
});

test('adb root that drops the connection is tried again; a production image is a refusal', () => {
  assert.equal(rootStep('uid=0(root) gid=0(root)', ''), 'root');
  assert.equal(rootStep('uid=2000(shell)', 'restarting adbd as root'), 'retry');
  assert.equal(rootStep('', "adb.exe: device 'emulator-5556' not found"), 'retry');
  assert.equal(rootStep('uid=2000(shell)', 'adbd cannot run as root in production builds'), 'refused');
  assert.equal(rootStep('uid=2000(shell)', 'adbd is already running as root'), 'root');
});

test('the recovery code has replaced the passphrase when its button has, and the field is there', () => {
  const edit: UiNode = { text: '', desc: '', id: '', cls: 'android.widget.EditText', bounds: [0, 0, 10, 10], enabled: true };
  assert.equal(recoveryCodeReady([edit, node('Use the passphrase instead')]), true);
  assert.equal(recoveryCodeReady([edit, node('Use the recovery code instead')]), false);
  assert.equal(recoveryCodeReady([node('Use the passphrase instead')]), false);
});

test('only a shown reminder may be found outside the backup, and only in the notification dump, the app data, or the store', () => {
  assert.equal(forbiddenCanary('shownCue', 'notif', 1), false);
  assert.equal(forbiddenCanary('shownCue', 'data', 7), false);
  assert.equal(forbiddenCanary('shownCue', 'xml', 7), false);
  assert.equal(forbiddenCanary('shownCue', 'backup', 1), true);
  assert.equal(forbiddenCanary('shownCue', 'log', 1), true);
  assert.equal(forbiddenCanary('privateCue', 'xml', 1), true);
  assert.equal(forbiddenCanary('privateCue', 'notif', 1), true);
  assert.equal(forbiddenCanary('diary', 'data', 1), true);
  assert.equal(forbiddenCanary('privateCue', 'xml', 0), false);
});

test('a backup is only the snapshot, judged on the full path, and a bare name does not pass', () => {
  const manifest = '/data/data/com.android.localtransport/files/1/_full/apps/app.dailycommit/_manifest';
  const snapshot = '/data/data/com.android.localtransport/files/1/_full/apps/app.dailycommit/f/backup/latest.dcbak';
  assert.equal(snapshotNames([manifest, snapshot]), undefined);
  assert.match(snapshotNames([manifest, snapshot, '/data/data/app.dailycommit/shared_prefs/NOTIFICATION_STORE.xml']) ?? '', /shared_prefs/);
  assert.match(snapshotNames(['_manifest', 'latest.dcbak']) ?? '', /latest\.dcbak/);
});

test('a missing or empty capture is a failed read, not a search that found nothing', () => {
  assert.throws(() => readSearched(join(tmpdir(), 'dc-8b-no-such-capture'), 'the backup'), /not read/);
  const dir = mkdtempSync(join(tmpdir(), 'dc-8b-'));
  const empty = join(dir, 'logcat.txt');
  writeFileSync(empty, new Uint8Array());
  try {
    assert.throws(() => readSearched(empty, 'the log'), /not read/);
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test('the passphrase-only lock is Locked and Open with the phone hint, and no device way', () => {
  const edit: UiNode = { text: '', desc: '', id: '', cls: 'android.widget.EditText', bounds: [0, 0, 10, 10], enabled: true };
  const screen = [node('LOCKED'), edit, node('Open'), node('Your passphrase. Your phone never stores it.'), node('Use the recovery code instead')];
  assert.equal(passphraseOnlyScreen(screen), undefined);
  assert.match(passphraseOnlyScreen([...screen, node('Use your passphrase')]) ?? '', /another way/);
  assert.match(passphraseOnlyScreen([...screen, node("Use your phone's PIN or pattern")]) ?? '', /another way/);
  assert.match(passphraseOnlyScreen([...screen, node('Unlock with fingerprint')]) ?? '', /another way/);
  assert.match(passphraseOnlyScreen([...screen, node('Use your code')]) ?? '', /another way/);
  assert.match(passphraseOnlyScreen([node('LOCKED'), node('Open')]) ?? '', /not up/);
});
