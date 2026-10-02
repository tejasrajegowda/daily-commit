import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fc from 'fast-check';
import { appDay, beforeBoundary, judged, nextStamp, openSheet, todayOf } from '../../src/record/time.ts';

const rule = { tz: 'UTC', boundary: 240 };
const at = (iso: string) => Date.parse(iso);
const DAY_MS = 86_400_000;

test('a clock set back a day after a write reopens nothing, and the next stamp still comes after the last', () => {
  const write = at('2026-09-28T12:00:00Z');
  assert.equal(todayOf(write - DAY_MS, write, rule), '2026-09-28');
  assert.equal(nextStamp(write - DAY_MS, write), write + 1);
  const sheet = openSheet(write - DAY_MS, write, rule);                          // a sheet opened on the wrong clock
  assert.equal(sheet.today, '2026-09-28');
  assert.equal(judged(sheet, write - DAY_MS + 60_000, write, rule).today, '2026-09-28');
});

test('a write made with the clock a day ahead holds today there until the real date catches up', () => {
  const ahead = at('2026-09-29T12:00:00Z');
  assert.equal(todayOf(at('2026-09-28T12:00:00Z'), ahead, rule), '2026-09-29');
  assert.equal(todayOf(at('2026-09-30T12:00:00Z'), ahead, rule), '2026-09-30');
});

test('days follow the home timezone from Settings, never the phone\'s', () => {
  const before = process.env.TZ;
  try {
    process.env.TZ = 'Pacific/Kiritimati';                                  // a phone set 14 hours ahead of UTC
    assert.equal(appDay(at('2026-09-28T16:00:00Z'), rule), '2026-09-28');   // the phone's own day would be the 29th
    assert.equal(appDay(at('2026-09-28T07:00:00Z'), { tz: 'America/New_York', boundary: 240 }), '2026-09-27');   // 03:00 there
  } finally {
    if (before === undefined) delete process.env.TZ;
    else process.env.TZ = before;
  }
});

test('a stamp always comes after the last one, whatever the clock says', () => {
  fc.assert(fc.property(fc.integer({ min: 0, max: 2 ** 41 }), fc.option(fc.integer({ min: 0, max: 2 ** 41 }), { nil: undefined }), (now, last) => {
    const stamp = nextStamp(now, last);
    assert.ok(stamp >= now);
    if (last !== undefined) assert.ok(stamp > last);
  }), { numRuns: 1000 });
});

test('between midnight and the boundary the morning screen offers the day ahead', () => {
  assert.equal(beforeBoundary(at('2026-09-28T03:50:00Z'), rule), true);
  assert.equal(beforeBoundary(at('2026-09-28T04:00:00Z'), rule), false);
  assert.equal(beforeBoundary(at('2026-09-27T23:50:00Z'), rule), false);
});
