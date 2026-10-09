import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emulatorArgs, PORT, SERIAL } from '../../scripts/android/emulator.ts';

test('the emulator runs on its own port, with no snapshot, no window, a software GPU and 3 GB', () => {
  assert.equal(PORT, 5556);
  assert.equal(SERIAL, 'emulator-5556');
  assert.deepEqual(emulatorArgs('dc-api33'), ['-avd', 'dc-api33', '-port', '5556', '-memory', '3072', '-no-snapshot',
    '-no-boot-anim', '-no-audio', '-no-window', '-gpu', 'swiftshader_indirect']);
});

test('another project\'s test phones are refused', () => {
  assert.throws(() => emulatorArgs('omni-api33'));
});
