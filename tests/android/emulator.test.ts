import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { anrShown, emulatorArgs, emulatorStopped, homeReady, mayRemoveFill, PORT, QUIET_DIALOGS, SERIAL, shouldStopProcessTree, taskkillArgs } from '../../scripts/android/emulator.ts';

test('the emulator is ready only once a real home screen has the focus, not the boot-time fallback', () => {
  // The focus lines a dc-api33 boot actually gave: the fallback first, then nothing, then the launcher.
  assert.equal(homeReady('  mCurrentFocus=Window{d98cafb u0 com.android.settings/com.android.settings.FallbackHome}\r\n'), false);
  assert.equal(homeReady('  mCurrentFocus=null\r\n'), false);
  assert.equal(homeReady(''), false);
  assert.equal(homeReady('  mCurrentFocus=Window{536fa63 u0 com.google.android.apps.nexuslauncher/com.google.android.apps.nexuslauncher.NexusLauncherActivity}\r\n'), true);
  // A boot on a busy PC can end with System UI's "not responding" dialog holding the focus.
  assert.equal(homeReady('  mCurrentFocus=Window{8e987a4 u0 Application Not Responding: com.android.systemui}\r\n'), false);
  assert.equal(anrShown('  mCurrentFocus=Window{8e987a4 u0 Application Not Responding: com.android.systemui}\r\n'), true);
  assert.equal(anrShown('  mCurrentFocus=null\r\n'), false);
});

test('the test phone is told not to show "isn\'t responding" dialogs before the boot counts as done', () => {
  // Seen on the test phone: System UI's dialog took the focus about 20 s after the home screen was ready.
  assert.deepEqual([...QUIET_DIALOGS], ['shell', 'settings', 'put', 'global', 'hide_error_dialogs', '1']);
  const src = readFileSync(new URL('../../scripts/android/emulator.ts', import.meta.url), 'utf8');
  const start = src.slice(src.indexOf('export async function startEmulator'));
  const quietAt = start.indexOf("adb(['-s', SERIAL, ...QUIET_DIALOGS]");
  const readyAt = start.indexOf('if (homeReady(focus))');
  assert.ok(quietAt > 0 && readyAt > quietAt);
});

test('the emulator runs on its own port, with no snapshot, no window, a software GPU and 3 GB', () => {
  assert.equal(PORT, 5556);
  assert.equal(SERIAL, 'emulator-5556');
  assert.deepEqual(emulatorArgs('dc-api33'), ['-avd', 'dc-api33', '-port', '5556', '-memory', '3072', '-no-snapshot',
    '-no-boot-anim', '-no-audio', '-no-window', '-gpu', 'swiftshader_indirect']);
});

test('another project\'s test phones are refused', () => {
  assert.throws(() => emulatorArgs('omni-api33'));
});

test('a leftover fill file is removed only when the listed phone names itself dc-', () => {
  assert.equal(mayRemoveFill('dc-api33\nOK\n', 0), true);
  assert.equal(mayRemoveFill('omni-api33\nOK\n', 0), false);
  assert.equal(mayRemoveFill('OK\n', 0), false);
  assert.equal(mayRemoveFill('OK\ndc-api33\n', 0), false);
  assert.equal(mayRemoveFill('dc-api33\n', 1), false);
});

test('a stop has worked only when our phone is unlisted and the process we started is gone', () => {
  assert.equal(emulatorStopped({ serialListed: false, ourPidAlive: false }), true);
  assert.equal(emulatorStopped({ serialListed: true, ourPidAlive: false }), false);
  assert.equal(emulatorStopped({ serialListed: false, ourPidAlive: true }), false);
  assert.equal(emulatorStopped({ serialListed: true, ourPidAlive: true }), false);
});

test('the process tree is stopped only for the pid this script started, and only while that pid is alive', () => {
  assert.equal(shouldStopProcessTree({ pid: 4242, alive: true }), true);
  assert.equal(shouldStopProcessTree({ pid: 4242, alive: false }), false);
  assert.equal(shouldStopProcessTree({ pid: undefined, alive: true }), false);
  assert.equal(shouldStopProcessTree({ pid: undefined, alive: false }), false);
});

test('the fallback stop is taskkill of that pid, as an argument list', () => {
  assert.deepEqual(taskkillArgs(4242), ['/PID', '4242', '/T', '/F']);
});
