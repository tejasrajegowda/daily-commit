import { test } from 'node:test';
import assert from 'node:assert/strict';
import { devicePort, platformOf } from '../../src/device/index.ts';

test('only a page inside the Android app gets the phone\'s port', async () => {
  assert.equal(platformOf({}), 'web');
  assert.equal(platformOf({ Capacitor: {} }), 'web');
  assert.equal(platformOf({ Capacitor: { getPlatform: () => 'web' } }), 'web');
  assert.equal(platformOf({ Capacitor: { getPlatform: () => 'android' } }), 'android');
  assert.equal((await devicePort()).deviceModes, false);      // Node has no bridge: the browser's port, and Capacitor never loads
});
