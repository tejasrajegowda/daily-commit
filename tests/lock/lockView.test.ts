import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fingerprintKey, lockLayout } from '../../src/lock/lockView.ts';

test('nothing offered, or a wide screen, means the passphrase', () => {
  assert.equal(lockLayout([], false), 'passphrase');
  assert.equal(lockLayout(['phone-lock'], true), 'passphrase');
  assert.equal(lockLayout(['own-code'], true), 'passphrase');
});

test('the phone lock, or the own-code pad when a code exists', () => {
  assert.equal(lockLayout(['phone-lock'], false), 'phone');
  assert.equal(lockLayout(['own-code'], false), 'code');
  assert.equal(lockLayout(['own-code', 'fingerprint'], false), 'code');
});

test('the pad shows the fingerprint key only while the fingerprint copy exists', () => {
  assert.equal(fingerprintKey(['own-code']), false);
  assert.equal(fingerprintKey(['own-code', 'fingerprint']), true);
});
