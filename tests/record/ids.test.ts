import { test } from 'node:test';
import assert from 'node:assert/strict';
import { uuidv7 } from '../../src/record/ids.ts';

test('a uuid v7 carries its time, and the version and variant bits', () => {
  const id = uuidv7(Date.UTC(2026, 0, 5), new Uint8Array(16).fill(0xff));
  assert.equal(id, '019b8b74-1800-7fff-bfff-ffffffffffff');
  assert.match(uuidv7(Date.UTC(2026, 0, 5)), /^019b8b74-1800-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});

test('an id made later sorts later', () => {
  assert.ok(uuidv7(1_000) < uuidv7(1_001));
});

test('ids made in the same millisecond never repeat', () => {
  assert.equal(new Set(Array.from({ length: 1000 }, () => uuidv7(5))).size, 1000);
});
