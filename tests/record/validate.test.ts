import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { HabitKind } from '../../src/rules/types.ts';
import { validValue } from '../../src/record/validate.ts';

test('each kind takes only its own values', () => {
  const ok: [HabitKind, unknown][] = [
    ['time', 0], ['time', 1679], ['min', 0], ['min', 1440], ['count', 0], ['count', 999],
    ['mood', 1], ['mood', 5], ['tri', 'did'], ['tri', 'partly'], ['tri', 'not'],
  ];
  const bad: [HabitKind, unknown][] = [
    ['time', 1680], ['time', -1], ['time', 90.5], ['time', 'not'], ['min', 1441], ['min', 2.5], ['min', '30'],
    ['count', 1000], ['count', -1], ['mood', 0], ['mood', 6], ['mood', 'not'], ['tri', 'maybe'], ['tri', 1],
  ];
  for (const [kind, value] of ok) assert.equal(validValue(kind, value, 240), true, `${kind} ${String(value)}`);
  for (const [kind, value] of bad) assert.equal(validValue(kind, value, 240), false, `${kind} ${String(value)}`);
});

test('a later boundary lets a time run later into the night', () => {
  assert.equal(validValue('time', 1739, 300), true);
  assert.equal(validValue('time', 1740, 300), false);
});
