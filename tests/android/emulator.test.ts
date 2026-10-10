import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emulatorArgs, emulatorStopped, PORT, SERIAL, shouldStopProcessTree, taskkillArgs } from '../../scripts/android/emulator.ts';

test('the emulator runs on its own port, with no snapshot, no window, a software GPU and 3 GB', () => {
  assert.equal(PORT, 5556);
  assert.equal(SERIAL, 'emulator-5556');
  assert.deepEqual(emulatorArgs('dc-api33'), ['-avd', 'dc-api33', '-port', '5556', '-memory', '3072', '-no-snapshot',
    '-no-boot-anim', '-no-audio', '-no-window', '-gpu', 'swiftshader_indirect']);
});

test('another project\'s test phones are refused', () => {
  assert.throws(() => emulatorArgs('omni-api33'));
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
