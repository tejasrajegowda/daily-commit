import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clockMinuteOf } from '../../src/rules/dates.ts';
import { toDayMinute } from '../../src/rules/clock.ts';
import { isOpen } from '../../src/record/seal.ts';
import { beforeBoundary, judged, openSheet, todayOf } from '../../src/record/time.ts';

const rule = { tz: 'UTC', boundary: 240 };
const at = (iso: string) => Date.parse(iso);

test('00:30 after the evening of the 27th is 1470 on the 27th, and the 27th is still open', () => {
  const now = at('2026-09-28T00:30:00Z');
  const today = todayOf(now, undefined, rule);
  assert.equal(today, '2026-09-27');
  assert.equal(toDayMinute(clockMinuteOf(now, rule.tz), 'evening', rule.boundary), 1470);
  assert.equal(isOpen('2026-09-27', 'value', today, false), true);
});

test('a 03:50 wake-up goes to the day ahead as 230, for a morning habit only, and one day only', () => {
  const now = at('2026-09-28T03:50:00Z');
  const today = todayOf(now, undefined, rule);                                // still the 27th
  const morningAhead = beforeBoundary(now, rule);
  assert.equal(toDayMinute(clockMinuteOf(now, rule.tz), 'morning', rule.boundary), 230);
  assert.equal(isOpen('2026-09-28', 'value', today, morningAhead), true);     // a habit asked in the morning
  assert.equal(isOpen('2026-09-28', 'value', today, false), false);           // a habit asked in the evening
  assert.equal(isOpen('2026-09-29', 'value', today, morningAhead), false);
});

test('saves at 03:59, 04:00 and 04:01: the day before yesterday closes at the boundary', () => {
  for (const [time, open] of [['03:59', true], ['04:00', false], ['04:01', false]] as const) {
    const today = todayOf(at(`2026-09-28T${time}:00Z`), undefined, rule);
    assert.equal(isOpen('2026-09-26', 'value', today, false), open, time);
    assert.equal(isOpen('2026-09-27', 'value', today, false), true, time);
  }
});

test('a sheet opened at 03:58 keeps its day until 10 minutes past the boundary', () => {
  const sheet = openSheet(at('2026-09-28T03:58:00Z'), undefined, rule);
  assert.equal(sheet.today, '2026-09-27');
  const firstSave = at('2026-09-28T04:05:00Z');
  assert.equal(isOpen('2026-09-26', 'value', judged(sheet, firstSave, undefined, rule).today, false), true);
  assert.equal(isOpen('2026-09-26', 'value', judged(sheet, at('2026-09-28T04:06:00Z'), firstSave, rule).today, false), true);   // a second save from the same sheet
  assert.equal(isOpen('2026-09-26', 'value', judged(sheet, at('2026-09-28T04:15:00Z'), firstSave, rule).today, false), false);
  assert.deepEqual(judged(undefined, firstSave, undefined, rule), { at: firstSave, today: '2026-09-28' });
});

test('a plan may go on any day from yesterday on; nothing goes on an older day', () => {
  const today = '2026-09-27';
  assert.equal(isOpen('2026-10-30', 'plan', today, false), true);
  assert.equal(isOpen('2026-09-26', 'plan', today, false), true);
  assert.equal(isOpen('2026-09-25', 'plan', today, false), false);
  assert.equal(isOpen('2026-09-28', 'value', today, false), false);
});
