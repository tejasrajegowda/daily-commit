import { test } from 'node:test';
import assert from 'node:assert/strict';
import { codeGroups, typedGroups } from '../../src/first-run/codeGroups.ts';
import { newRecoveryCode } from '../../src/vault/recovery.ts';
import { systemRandom } from '../../src/vault/random.ts';

test('a printed code is eight groups of five, then the check symbol', () => {
  const groups = codeGroups(newRecoveryCode(systemRandom).text);
  assert.equal(groups.length, 9);
  assert.ok(groups.slice(0, 8).every(g => g.length === 5));
  assert.equal(groups[8]?.length, 1);
});

test('typing back: upper-cased, spaces and dashes ignored, finished groups and the one being typed', () => {
  assert.deepEqual(typedGroups(''), { done: [], current: '' });
  assert.deepEqual(typedGroups('k7m2q x4t'), { done: ['K7M2Q'], current: 'X4T' });
  assert.deepEqual(typedGroups('K7M2Q-X4TR9-'), { done: ['K7M2Q', 'X4TR9'], current: '' });
  assert.deepEqual(typedGroups('A'.repeat(40) + 'Z'), { done: Array(8).fill('AAAAA'), current: 'Z' });
});
