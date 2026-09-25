import { test } from 'node:test';
import assert from 'node:assert/strict';
import { doneAndAsked, habitNumbers } from '../../src/rules/stats.ts';
import { indexObservations } from '../../src/rules/state.ts';
import { addDays } from '../../src/rules/dates.ts';
import { history, read, START, tri, walk } from './fixtures.ts';

/** Numbers for the walk habit given a pattern, with the last character being today. */
function numbers(pattern: string) {
  const idx = indexObservations(history('walk', tri(pattern)));
  return habitNumbers(walk, idx, START, addDays(START, pattern.length - 1));
}

test('one quiet day never ends a run; two in a row do', () => {
  assert.deepEqual(numbers('dd.d'), { did: 3, minutes: 0, longestRun: 3, currentRun: 3, cameBack: 1, gaps: 1 });
  assert.deepEqual(numbers('dd..d'), { did: 3, minutes: 0, longestRun: 2, currentRun: 1, cameBack: 0, gaps: 1 });
});

test('"not today" and never answered are the same quiet day', () => {
  assert.deepEqual(numbers('ddnd'), numbers('dd.d'));
  assert.deepEqual(numbers('ddnnd'), numbers('dd..d'));
});

test('partly keeps a run alive but does not lengthen it', () => {
  assert.equal(numbers('dpd').currentRun, 2);
  assert.equal(numbers('d.p.d').currentRun, 2);        // the partly day breaks up the two quiet days
  assert.equal(numbers('d.p.d').gaps, 2);
  assert.equal(numbers('d.p.d').cameBack, 1);          // only the second gap was followed by a done day
});

test('planned days and rest days are skipped, not counted as quiet', () => {
  assert.equal(numbers('ddrrrd').currentRun, 3);
  assert.equal(numbers('dd.r.d').currentRun, 1);       // quiet, rest, quiet is still two quiet days
});

test('today is never held against a run until the day is over', () => {
  assert.equal(numbers('dd.').currentRun, 2);          // yesterday done, today not yet answered
  assert.equal(numbers('d..').currentRun, 1);          // yesterday quiet, today not yet: still one quiet day
  assert.equal(numbers('d...').currentRun, 0);
});

test('minutes add up only on minutes habits, and planned days add nothing', () => {
  const idx = indexObservations(history('read', [{ value: 20 }, { value: 5 }, null, { planned: 'meeting' }, { value: 40 }]));
  const n = habitNumbers(read, idx, START, addDays(START, 4));
  assert.equal(n.minutes, 65);
  assert.equal(n.did, 2);
});

test('done and asked leave out planned and off days', () => {
  const idx = indexObservations(history('walk', tri('ddrn.dp')));
  assert.deepEqual(doneAndAsked(walk, idx, START, addDays(START, 6)), { done: 3, asked: 6 });
});
