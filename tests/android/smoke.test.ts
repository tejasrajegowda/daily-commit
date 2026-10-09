import { test } from 'node:test';
import assert from 'node:assert/strict';
import { channelProblems, pageLoaded, windowIsSecure } from '../../scripts/android/smoke.ts';

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
