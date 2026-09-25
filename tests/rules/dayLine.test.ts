import { test } from 'node:test';
import assert from 'node:assert/strict';
import { blockAt, position, shapeFor, stepsAround, sunHasSet, type DayShape } from '../../src/rules/dayLine.ts';

// An invented day: the strip runs 06:00–22:00.
const weekday: DayShape = {
  window: { from: 360, to: 1320 },
  blocks: [{ start: 540, end: 1020, label: 'Work' }, { start: 1080, end: 1140, label: 'Gym' }],
  steps: [{ at: 360, label: 'Up' }, { at: 540, label: 'Start work' }, { at: 1260, label: 'Wind down' }],
  lightsOut: 1320,
};
const weekend: DayShape = { ...weekday, blocks: [] };

test('positions run 0–100 across the window and clamp outside it', () => {
  assert.equal(position(weekday, 360), 0);
  assert.equal(position(weekday, 840), 50);
  assert.equal(position(weekday, 1320), 100);
  assert.equal(position(weekday, 100), 0);
  assert.equal(position(weekday, 1400), 100);
});

test('the block now, and the steps either side of now', () => {
  assert.equal(blockAt(weekday, 600)?.label, 'Work');
  assert.equal(blockAt(weekday, 1020), undefined);
  assert.equal(blockAt(weekday, 1100)?.label, 'Gym');
  assert.deepEqual(stepsAround(weekday, 600), { current: weekday.steps[1], next: weekday.steps[2] });
  assert.deepEqual(stepsAround(weekday, 300), { current: undefined, next: weekday.steps[0] });
  assert.deepEqual(stepsAround(weekday, 1300), { current: weekday.steps[2], next: undefined });
});

test('the sun sets at lights-out and rises with the window', () => {
  assert.equal(sunHasSet(weekday, 1320), true);
  assert.equal(sunHasSet(weekday, 200), true);
  assert.equal(sunHasSet(weekday, 360), false);
});

test('weekends get their own shape', () => {
  assert.equal(shapeFor('2026-01-09', weekday, weekend), weekday);   // Friday
  assert.equal(shapeFor('2026-01-10', weekday, weekend), weekend);   // Saturday
  assert.equal(shapeFor('2026-01-11', weekday, weekend), weekend);   // Sunday
});
