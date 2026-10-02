import { test } from 'node:test';
import assert from 'node:assert/strict';
import { askedOn, inPlan, isAsked, isRetired, scheduleOn, stateOf, tierOn } from '../../src/rules/state.ts';
import type { Observation } from '../../src/rules/types.ts';
import { EVERY_DAY, habit, mood, read, reps, rise, scheduled, START, walk, WEEKDAYS } from './fixtures.ts';

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

test('a recorded value wins over a plan made in advance; off days and days outside the plan are neither', () => {
  assert.equal(stateOf(walk, { habitId: 'walk', date: START, planned: 'unwell', value: 'did' }, START), 'did');
  assert.equal(stateOf(walk, { habitId: 'walk', date: START, planned: 'unwell' }, START), 'planned');
  const weekdays = habit({ id: 'wd', kind: 'tri', schedule: scheduled(WEEKDAYS) });
  assert.equal(stateOf(weekdays, on('wd', 'did', '2026-01-10'), '2026-01-10'), 'off');
  const later = habit({ id: 'l', kind: 'tri', periods: [{ from: '2026-01-07', until: '2026-01-09' }] });
  assert.equal(stateOf(later, undefined, '2026-01-06'), 'outside');
  assert.equal(stateOf(later, undefined, '2026-01-08'), 'nothing');
  assert.equal(stateOf(later, undefined, '2026-01-09'), 'outside');
  assert.equal(isAsked(later, '2026-01-08'), true);
  assert.equal(isAsked(weekdays, '2026-01-11'), false);
});

test('a habit can leave the plan and come back; the days away are outside it', () => {
  const back = habit({ id: 'b', kind: 'tri', periods: [{ from: START, until: '2026-01-08' }, { from: '2026-01-12' }] });
  assert.equal(stateOf(back, undefined, '2026-01-07'), 'nothing');
  assert.equal(stateOf(back, on('b', 'did', '2026-01-08'), '2026-01-08'), 'outside');
  assert.equal(stateOf(back, undefined, '2026-01-11'), 'outside');
  assert.equal(stateOf(back, on('b', 'did', '2026-01-12'), '2026-01-12'), 'did');
  assert.equal(inPlan(back, '2026-01-10'), false);
  assert.equal(isRetired(back), false);
  assert.equal(isRetired(habit({ id: 'r', kind: 'tri', periods: [{ from: START, until: '2026-01-08' }] })), true);
});

test('a weekday change applies from its own day and leaves earlier weeks as they were', () => {
  const changed = habit({ id: 'c', kind: 'tri', schedule: [...scheduled(EVERY_DAY), { from: '2026-01-12', days: WEEKDAYS, asked: 'morning' }] });
  assert.equal(stateOf(changed, undefined, '2026-01-10'), 'nothing');     // a Saturday, under the old weekdays
  assert.equal(stateOf(changed, undefined, '2026-01-17'), 'off');         // a Saturday, under the new ones
  assert.equal(scheduleOn(changed, '2026-01-11')?.asked, 'evening');
  assert.equal(askedOn(changed, '2026-01-13'), 'morning');
  assert.equal(askedOn(changed, '2026-01-17'), undefined);               // not asked that day
});

test('before the first schedule entry a day is off, never counted', () => {
  const early = habit({ id: 'e', kind: 'tri', schedule: scheduled(EVERY_DAY, '2026-01-07') });
  assert.equal(stateOf(early, on('e', 'did', '2026-01-06'), '2026-01-06'), 'off');
  assert.equal(askedOn(early, '2026-01-06'), undefined);
});

test('changing a target re-reads the past without touching it', () => {
  const stricter = { ...rise, target: { band: 390, part: 400 } };
  const obs = on('rise', 410);
  assert.equal(stateOf(rise, obs, START), 'did');
  assert.equal(stateOf(stricter, obs, START), 'nothing');
});

test('a bedtime is judged on the day it belongs to, through midnight', () => {
  const bed = habit({ id: 'bed', kind: 'time', target: { band: 1410, part: 1470 } });   // in bed by 23:30, partly by 00:30
  assert.equal(stateOf(bed, on('bed', 1380), START), 'did');       // 23:00
  assert.equal(stateOf(bed, on('bed', 1410), START), 'did');       // 23:30
  assert.equal(stateOf(bed, on('bed', 1440), START), 'partly');    // 00:00
  assert.equal(stateOf(bed, on('bed', 1470), START), 'partly');    // 00:30
  assert.equal(stateOf(bed, on('bed', 1471), START), 'nothing');
});

test('tier history gives the tier in force on each day', () => {
  const h = habit({ id: 't', kind: 'tri', tierHistory: [{ tier: 'focus', from: '2026-01-05' }, { tier: 'log', from: '2026-03-02' }] });
  assert.equal(tierOn(h, '2026-01-04'), null);
  assert.equal(tierOn(h, '2026-01-05'), 'focus');
  assert.equal(tierOn(h, '2026-03-01'), 'focus');
  assert.equal(tierOn(h, '2026-03-02'), 'log');
});
