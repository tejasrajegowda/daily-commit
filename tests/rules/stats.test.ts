import { test } from 'node:test';
import assert from 'node:assert/strict';
import { doneAndAsked, habitNumbers } from '../../src/rules/stats.ts';
import { indexObservations } from '../../src/rules/state.ts';
import { addDays } from '../../src/rules/dates.ts';
import { habit, history, read, START, tri, walk } from './fixtures.ts';

/** Numbers for the walk habit given a pattern, with the last character being today. */
function numbers(pattern: string) {
  const idx = indexObservations(history('walk', tri(pattern)));
  return habitNumbers(walk, idx, START, addDays(START, pattern.length - 1));
}

test('a quiet day ends a run once it has sealed', () => {
  assert.deepEqual(numbers('dd.ddd'), { did: 5, minutes: 0, longestRun: 3, currentRun: 3, cameBack: 1 });
});

test('"not today" and never answered are the same quiet day', () => {
  assert.deepEqual(numbers('ddnddd'), numbers('dd.ddd'));
  assert.deepEqual(numbers('ddd.n'), numbers('ddd..'));
});

test('a quiet yesterday holds the run until it seals: alive, and not lengthened across it', () => {
  assert.deepEqual(numbers('ddd..'), { did: 3, minutes: 0, longestRun: 3, currentRun: 3, cameBack: 0 });
  assert.deepEqual(numbers('ddd.d'), { did: 4, minutes: 0, longestRun: 3, currentRun: 3, cameBack: 0 });
  assert.equal(numbers('ddd...').currentRun, 0);
  assert.equal(numbers('ddd...').longestRun, 3);
});

test('partly keeps a run alive but does not lengthen it', () => {
  assert.equal(numbers('dpd').currentRun, 2);
  assert.equal(numbers('dpdd').longestRun, 3);
});

test('a rest day marked in advance is skipped; a plan made on the day is a quiet day', () => {
  assert.equal(numbers('ddrd').currentRun, 3);
  assert.equal(numbers('ddrrrd').currentRun, 3);
  assert.deepEqual(numbers('ddxdd'), { did: 4, minutes: 0, longestRun: 2, currentRun: 2, cameBack: 0 });
  assert.equal(numbers('ddxddd').cameBack, 1);
});

test('today is never held against a run until the day is over', () => {
  assert.equal(numbers('dd.').currentRun, 2);
  assert.equal(numbers('ddn').currentRun, 2);
});

test('came back counts only days that have sealed', () => {
  assert.equal(numbers('d.dd').cameBack, 0);          // the done day after the gap is yesterday, still open
  assert.equal(numbers('d.ddd').cameBack, 1);
  assert.equal(numbers('d..ddd').cameBack, 0);         // two quiet days are not a single gap
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

test('time away from the plan is skipped like a rest day, so a run carries across it', () => {
  const away = habit({ id: 'walk', kind: 'tri', periods: [{ from: START, until: addDays(START, 2) }, { from: addDays(START, 5) }] });
  const idx = indexObservations(history('walk', tri('dd...d')));
  const n = habitNumbers(away, idx, START, addDays(START, 5));
  assert.equal(n.currentRun, 3);
  assert.deepEqual(doneAndAsked(away, idx, START, addDays(START, 5)), { done: 3, asked: 3 });
});
