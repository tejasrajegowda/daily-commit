import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fc from 'fast-check';
import { clockOfDay, isDayMinute, lastDayMinute, toDayMinute } from '../../src/rules/clock.ts';
import type { Asked } from '../../src/rules/types.ts';

test('an evening time after midnight is placed after the evening it belongs to', () => {
  assert.equal(toDayMinute(30, 'evening'), 1470);          // 00:30
  assert.equal(toDayMinute(239, 'evening'), 1679);         // 03:59, the last minute of the day
  assert.equal(toDayMinute(240, 'evening'), 240);          // 04:00 is already the next day's start
  assert.equal(toDayMinute(1410, 'evening'), 1410);        // 23:30
});

test('a morning time is kept as it is, so a 03:50 wake-up belongs to the day ahead', () => {
  assert.equal(toDayMinute(230, 'morning'), 230);
  assert.equal(toDayMinute(372, 'morning'), 372);          // 06:12
});

test('the boundary moves the line between one day and the next', () => {
  assert.equal(toDayMinute(270, 'evening', 300), 1710);    // 04:30, with days turning at 05:00
  assert.equal(lastDayMinute(), 1679);
  assert.equal(lastDayMinute(300), 1739);
});

test('a DayMinute is shown as its clock time, and only an app day\'s minutes are DayMinutes', () => {
  assert.equal(clockOfDay(1470), 30);
  assert.equal(clockOfDay(1410), 1410);
  assert.equal(isDayMinute(0), true);
  assert.equal(isDayMinute(1679), true);
  assert.equal(isDayMinute(1680), false);
  assert.equal(isDayMinute(-1), false);
  assert.equal(isDayMinute(90.5), false);
});

test('placing a clock time on its day never changes the time shown', () => {
  fc.assert(fc.property(
    fc.integer({ min: 0, max: 1439 }), fc.constantFrom<Asked>('morning', 'evening'), fc.integer({ min: 0, max: 360 }),
    (clock, asked, boundary) => {
      const m = toDayMinute(clock, asked, boundary);
      assert.equal(clockOfDay(m), clock);
      assert.ok(isDayMinute(m, boundary));
    }), { numRuns: 1000 });
});
