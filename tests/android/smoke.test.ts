import { test } from 'node:test';
import assert from 'node:assert/strict';
import { channelProblems, dumpWroteFile, isDcTestPhone, isLeftoverPassFile, pageLoaded, smokeArgsOk, windowIsSecure } from '../../scripts/android/smoke.ts';

test('the app\'s own window must carry the SECURE flag', () => {
  const ours = '  Window #3 Window{a1 u0 app.dailycommit/app.dailycommit.MainActivity}:\n    mAttrs={(0,0)(fillxfill) ty=BASE_APPLICATION fl=LAYOUT_IN_SCREEN SECURE HARDWARE_ACCELERATED}\n';
  assert.equal(windowIsSecure(ours), true);
  assert.equal(windowIsSecure(ours.replace(' SECURE', '')), false);
  assert.equal(windowIsSecure('  Window #3 Window{a1 u0 com.other/com.other.Main}:\n    mAttrs={fl=SECURE}\n'), false);
});

test('the reminder channel is silent, badge-free and never public on the lock screen', () => {
  // Android overwrites an app's own lock-screen setting on a new channel with "no override" (-1000), so each
  // notification's own visibility decides (the plugin builds every one PRIVATE); public (1) is what must fail.
  const ok = "NotificationChannel{mId='default', mName=Reminders, mImportance=2, mBypassDnd=false, mLockscreenVisibility=-1000, mSound=null, mLights=false, mShowBadge=false, mVibrationEnabled=false}";
  assert.deepEqual(channelProblems(`AppSettings: app.dailycommit (10190)\n  ${ok}`), []);
  assert.deepEqual(channelProblems(`AppSettings: app.dailycommit (10190)\n  ${ok.replace('=-1000', '=0')}`), []);
  for (const bad of [ok.replace('mImportance=2', 'mImportance=3'), ok.replace('mShowBadge=false', 'mShowBadge=true'),
    ok.replace('mLockscreenVisibility=-1000', 'mLockscreenVisibility=1'), ok.replace('mSound=null', 'mSound=content://settings/system/alarm_alert')])
    assert.notDeepEqual(channelProblems(`AppSettings: app.dailycommit (10190)\n  ${bad}`), [], bad);
  assert.notDeepEqual(channelProblems('AppSettings: app.dailycommit (10190)\n'), []);       // no channel at all
});

test('the page counts as loaded only when its own words are on screen', () => {
  assert.equal(pageLoaded('<node text="Daily Commit" class="android.widget.TextView"/>', 'Daily Commit'), true);
  assert.equal(pageLoaded('<node text="Webpage not available" /><node text="net::ERR_CACHE_MISS"/>', 'Daily Commit'), false);
});

test('a screen dump counts only when this try wrote the file and the read succeeded', () => {
  const wrote = 'UI hierchary dumped to: /sdcard/dc-ui.xml\n';
  assert.equal(dumpWroteFile(0, wrote, 0), true);
  assert.equal(dumpWroteFile(0, 'UI hierchary Dumped To: /sdcard/dc-ui.xml', 0), true);
  assert.equal(dumpWroteFile(1, wrote, 0), false);
  assert.equal(dumpWroteFile(0, 'ERROR: could not get idle state.', 0), false);
  assert.equal(dumpWroteFile(0, wrote, 1), false);
  assert.equal(dumpWroteFile(0, '', 0), false);
});

test('the name check allows only our own test phone', () => {
  assert.equal(isDcTestPhone('dc-api33'), true);
  assert.equal(isDcTestPhone('dc-api33\r\nOK\r\n'), true);
  assert.equal(isDcTestPhone('\ndc-api33\nOK\n'), true);
  assert.equal(isDcTestPhone('omni-api33'), false);
  assert.equal(isDcTestPhone(''), false);
  assert.equal(isDcTestPhone('OK'), false);
  assert.equal(isDcTestPhone('OK\ndc-api33'), false);
});

test('a leftover password file is only pass-*.tmp in this folder', () => {
  assert.equal(isLeftoverPassFile('pass-ab12cd.tmp'), true);
  assert.equal(isLeftoverPassFile('pass-.tmp'), true);
  assert.equal(isLeftoverPassFile('password.tmp'), false);
  assert.equal(isLeftoverPassFile('pass-ab12cd.tmp.txt'), false);
  assert.equal(isLeftoverPassFile('pass-ab12cd.json'), false);
  assert.equal(isLeftoverPassFile('emulator-only.jks'), false);
});

test('smoke takes no arguments yet', () => {
  assert.equal(smokeArgsOk([]), true);
  assert.equal(smokeArgsOk(['--avd', 'dc-api37']), false);
  assert.equal(smokeArgsOk(['--help']), false);
});
