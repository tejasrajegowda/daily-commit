import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fingerprintKey, lockLayout } from '../../src/lock/lockView.ts';

test('nothing offered means the passphrase (a browser never offers anything)', () => {
  assert.equal(lockLayout([]), 'passphrase');
});

test('the phone lock, or the own-code pad when a code exists', () => {
  assert.equal(lockLayout(['phone-lock']), 'phone');
  assert.equal(lockLayout(['own-code']), 'code');
  assert.equal(lockLayout(['own-code', 'fingerprint']), 'code');
});

test('D-38: the lock never decides by the screen\'s width; a wide tablet is still the phone app', () => {
  // the tablet run, 16 Nov: a wide screen was taken for a computer, so the own code was never offered there
  const view = readFileSync('src/lock/lockView.ts', 'utf8');
  const screen = readFileSync('src/lock/LockScreen.tsx', 'utf8');
  assert.doesNotMatch(screen, /useWide|matchMedia/);
  assert.match(screen, /computer=\{!device\.deviceModes\}/, 'the computer\'s words follow the device, not the width');
  assert.match(view, /export function lockLayout\(offered: readonly DeviceMode\[\]\): LockLayout/);
});

test('the pad shows the fingerprint key only while the fingerprint copy exists', () => {
  assert.equal(fingerprintKey(['own-code']), false);
  assert.equal(fingerprintKey(['own-code', 'fingerprint']), true);
});
