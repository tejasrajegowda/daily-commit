import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isAsked, stateOf, tierOn } from '../../src/rules/state.ts';
import type { Observation } from '../../src/rules/types.ts';
import { habit, mood, read, reps, rise, START, walk } from './fixtures.ts';

const on = (habitId: string, value: Observation['value'], date = START): Observation => ({ habitId, date, value });

test('a clock time: inside the band is done, inside the slack is partly, later is nothing', () => {
  assert.equal(stateOf(rise, on('rise', 400), START), 'did');
  assert.equal(stateOf(rise, on('rise', 420), START), 'did');
  assert.equal(stateOf(rise, on('rise', 421), START), 'partly');
  assert.equal(stateOf(rise, on('rise', 450), START), 'partly');
  assert.equal(stateOf(rise, on('rise', 451), START), 'nothing');
});

test('minutes and counts: at the bar is done, below it partly, zero is nothing', () => {
  assert.equal(stateOf(read, on('read', 15), START), 'did');
  assert.equal(stateOf(read, on('read', 5), START), 'partly');
  assert.equal(stateOf(read, on('read', 0), START), 'nothing');
  assert.equal(stateOf(reps, on('reps', 12), START), 'did');
  assert.equal(stateOf(reps, on('reps', 3), START), 'partly');
});

test('three-way answers map straight across', () => {
  assert.equal(stateOf(walk, on('walk', 'did'), START), 'did');
  assert.equal(stateOf(walk, on('walk', 'partly'), START), 'partly');
  assert.equal(stateOf(walk, on('walk', 'not'), START), 'nothing');
  assert.equal(stateOf(walk, undefined, START), 'nothing');
});

test('mood is recorded, never judged', () => {
  assert.equal(stateOf(mood, on('mood', 1), START), 'did');
  assert.equal(stateOf(mood, on('mood', 5), START), 'did');
});

test('planned wins over any value; off days and days outside the habit are neither', () => {
  assert.equal(stateOf(walk, { habitId: 'walk', date: START, planned: 'unwell', value: 'did' }, START), 'planned');
  const weekdays = habit({ id: 'wd', kind: 'tri', days: [0, 1, 2, 3, 4] });
  assert.equal(stateOf(weekdays, on('wd', 'did', '2026-01-10'), '2026-01-10'), 'off');
  const later = habit({ id: 'l', kind: 'tri', createdOn: '2026-01-07', retiredOn: '2026-01-09' });
  assert.equal(stateOf(later, undefined, '2026-01-06'), 'outside');
  assert.equal(stateOf(later, undefined, '2026-01-08'), 'nothing');
  assert.equal(stateOf(later, undefined, '2026-01-09'), 'outside');
  assert.equal(isAsked(later, '2026-01-08'), true);
  assert.equal(isAsked(weekdays, '2026-01-11'), false);
});

test('changing a target re-reads the past without touching it', () => {
  const stricter = { ...rise, target: { band: 390, part: 400 } };
  const obs = on('rise', 410);
  assert.equal(stateOf(rise, obs, START), 'did');
  assert.equal(stateOf(stricter, obs, START), 'nothing');
});

test('tier history gives the tier in force on each day', () => {
  const h = habit({ id: 't', kind: 'tri', tierHistory: [{ tier: 'focus', from: '2026-01-05' }, { tier: 'log', from: '2026-03-02' }] });
  assert.equal(tierOn(h, '2026-01-04'), null);
  assert.equal(tierOn(h, '2026-01-05'), 'focus');
  assert.equal(tierOn(h, '2026-03-01'), 'focus');
  assert.equal(tierOn(h, '2026-03-02'), 'log');
});
