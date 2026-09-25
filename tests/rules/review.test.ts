// The months view, the settled offer and "what seems to go well together".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { focusDone, heatLevel } from '../../src/rules/heat.ts';
import { offersToSettle } from '../../src/rules/settled.ts';
import { goesWellTogether } from '../../src/rules/patterns.ts';
import { indexObservations } from '../../src/rules/state.ts';
import { addDays } from '../../src/rules/dates.ts';
import type { Observation } from '../../src/rules/types.ts';
import { habit, history, mood, read, rise, START, tri, walk, type Cell } from './fixtures.ts';

test('heat: done counts 1, partly a half, and only what was in Focus that day', () => {
  const logOnly = habit({ id: 'log', kind: 'tri', tierHistory: [{ tier: 'log', from: START }] });
  const idx = indexObservations([
    ...history('walk', tri('d')), ...history('read', [{ value: 5 }]), ...history('log', tri('d')), ...history('mood', [{ value: 5 }]),
  ]);
  assert.equal(focusDone([walk, read, logOnly, mood], idx, START), 1.5);
  assert.deepEqual([0, 0.5, 1, 1.5, 2, 2.5, 3, 4, 5].map(heatLevel), [0, 1, 1, 1, 2, 2, 3, 4, 4]);
});

test('heat reads the tier in force on the day, so a habit that settled never dims its Focus days', () => {
  const moved = habit({ id: 'm', kind: 'tri', tierHistory: [{ tier: 'focus', from: START }, { tier: 'log', from: addDays(START, 1) }] });
  const idx = indexObservations(history('m', tri('dd')));
  assert.equal(focusDone([moved], idx, START), 1);
  assert.equal(focusDone([moved], idx, addDays(START, 1)), 0);
});

/** Eight weeks of a daily tri habit from START, each week given as a 7-letter pattern. */
function weeks(...ws: string[]) {
  return indexObservations(history('walk', tri(ws.join(''))));
}
const lastOfEight = addDays(START, 55);

test('settled: offered after eight weeks of at least 6 in 7', () => {
  assert.equal(offersToSettle(walk, weeks(...Array(8).fill('dddddd.')), lastOfEight), true);
  assert.equal(offersToSettle(walk, weeks(...Array(8).fill('ddddddr')), lastOfEight), true);     // a rest day is not asked
});

test('settled: one weaker week holds the offer back, even inside a good average', () => {
  const w = Array(8).fill('ddddddd'); w[3] = 'ddddd..';
  assert.equal(offersToSettle(walk, weeks(...w), lastOfEight), false);
});

test('settled: never offered for mood, a retired habit, or a habit not in Focus the whole time', () => {
  const full = weeks(...Array(8).fill('ddddddd'));
  assert.equal(offersToSettle(mood, full, lastOfEight), false);
  assert.equal(offersToSettle({ ...walk, retiredOn: addDays(START, 60) }, full, lastOfEight), false);
  const late = { ...walk, tierHistory: [{ tier: 'log' as const, from: START }, { tier: 'focus' as const, from: addDays(START, 7) }] };
  assert.equal(offersToSettle(late, full, lastOfEight), false);
});

/** 20 invented days: walk done on even days; `then` gets `good` on walk days and `other` otherwise. */
function paired(thenId: string, good: Cell, other: Cell, days = 20): Observation[] {
  const walkCells: Cell[] = [], thenCells: Cell[] = [];
  for (let i = 0; i < days; i++) {
    walkCells.push(i % 2 === 0 ? { value: 'did' } : { value: 'not' });
    thenCells.push(i % 2 === 0 ? good : other);
  }
  return [...history('walk', walkCells), ...history(thenId, thenCells)];
}
const to = addDays(START, 19);

test('patterns: nothing before day 60, whatever the data says', () => {
  const idx = indexObservations(paired('mood', { value: 5 }, { value: 2 }));
  assert.deepEqual(goesWellTogether([walk, mood], idx, [{ when: 'walk', then: 'mood' }], START, to, 59), []);
  assert.equal(goesWellTogether([walk, mood], idx, [{ when: 'walk', then: 'mood' }], START, to, 60).length, 1);
});

test('patterns: only what went well together, and only with eight days on each side', () => {
  const pair = [{ when: 'walk', then: 'read' }];
  const up = indexObservations(paired('read', { value: 40 }, { value: 10 }));
  const found = goesWellTogether([walk, read], up, pair, START, to, 90);
  assert.deepEqual(found, [{ when: 'walk', then: 'read', withDays: 10, withoutDays: 10, withValue: 40, withoutValue: 10 }]);
  const down = indexObservations(paired('read', { value: 10 }, { value: 40 }));
  assert.deepEqual(goesWellTogether([walk, read], down, pair, START, to, 90), []);
  const short = indexObservations(paired('read', { value: 40 }, { value: 10 }, 14));
  assert.deepEqual(goesWellTogether([walk, read], short, pair, START, addDays(START, 13), 90), []);
});

test('patterns: an earlier clock time is the better one', () => {
  const idx = indexObservations(paired('rise', { value: 400 }, { value: 440 }));
  assert.equal(goesWellTogether([walk, rise], idx, [{ when: 'walk', then: 'rise' }], START, to, 90).length, 1);
});

test('patterns: mood is never the thing compared by', () => {
  const idx = indexObservations([...paired('read', { value: 40 }, { value: 10 }), ...history('mood', Array(20).fill({ value: 3 }))]);
  assert.deepEqual(goesWellTogether([walk, read, mood], idx, [{ when: 'mood', then: 'read' }], START, to, 90), []);
});
