import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DevicePort } from '../../src/app/context.ts';
import { browserPort } from '../../src/device/browser.ts';
import { devicePort, platformOf } from '../../src/device/index.ts';

const phoneShaped = (): DevicePort => ({
  ...browserPort(),
  deviceModes: true,
  pickFile: async () => ({ kind: 'Cancelled' }),
  sleep: async () => {},
  onBack: () => () => {},
  leaveApp: () => {},
});

test('only a page inside the Android app gets the phone\'s port', async () => {
  assert.equal(platformOf({}), 'web');
  assert.equal(platformOf({ Capacitor: {} }), 'web');
  assert.equal(platformOf({ Capacitor: { getPlatform: () => 'web' } }), 'web');
  assert.equal(platformOf({ Capacitor: { getPlatform: () => 'android' } }), 'android');
  assert.equal((await devicePort()).deviceModes, false);      // Node has no bridge: the browser's port, and Capacitor never loads
  let loads = 0;
  const load = async () => { loads += 1; return phoneShaped(); };
  assert.equal((await devicePort({ Capacitor: { getPlatform: () => 'web' } }, load)).deviceModes, false);
  assert.equal(loads, 0);                                     // a browser never loads the phone port
  const phone = await devicePort({ Capacitor: { getPlatform: () => 'android' } }, load);
  assert.equal(loads, 1);                                     // a stub that always returns the browser port never loads it
  assert.equal(phone.deviceModes, true);
  assert.equal(typeof phone.pickFile, 'function');
  assert.equal(typeof phone.sleep, 'function');
  assert.equal(typeof phone.onBack, 'function');
  assert.equal(typeof phone.leaveApp, 'function');
});
