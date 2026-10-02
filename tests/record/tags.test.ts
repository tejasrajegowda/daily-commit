import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TABLE_TAGS } from '../../src/vault/tags.ts';

test('the table tags are frozen, distinct, and exactly these', () => {
  assert.ok(Object.isFrozen(TABLE_TAGS));
  assert.deepEqual({ ...TABLE_TAGS }, { settings: 'set', habits: 'hab', observations: 'obs', days: 'day', entries: 'ent', notyet: 'nyt', cues: 'cue', reviews: 'rev' });
  assert.equal(new Set(Object.values(TABLE_TAGS)).size, 8);
});
