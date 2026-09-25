import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addDays, datesFrom, daysBetween, localDateOf, weekdayOf, clockMinuteOf } from '../../src/rules/dates.ts';

test('calendar arithmetic crosses months, years and leap days', () => {
  assert.equal(addDays('2026-01-31', 1), '2026-02-01');
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
  assert.equal(addDays('2028-02-28', 1), '2028-02-29');
  assert.equal(addDays('2026-03-01', -1), '2026-02-28');
  assert.equal(daysBetween('2026-01-05', '2026-02-04'), 30);
  assert.equal(daysBetween('2026-02-04', '2026-01-05'), -30);
  assert.deepEqual(datesFrom('2026-01-30', '2026-02-02'), ['2026-01-30', '2026-01-31', '2026-02-01', '2026-02-02']);
  assert.deepEqual(datesFrom('2026-01-02', '2026-01-01'), []);
});

test('weekdays count from Monday', () => {
  assert.equal(weekdayOf('2026-01-05'), 0);
  assert.equal(weekdayOf('2026-01-10'), 5);
  assert.equal(weekdayOf('2026-01-11'), 6);
});

test('the day ends at 04:00, not at midnight', () => {
  const tz = 'America/New_York';                       // UTC−5 in January
  assert.equal(localDateOf(Date.parse('2026-01-06T05:30:00Z'), tz), '2026-01-05');   // 00:30
  assert.equal(localDateOf(Date.parse('2026-01-06T08:59:00Z'), tz), '2026-01-05');   // 03:59
  assert.equal(localDateOf(Date.parse('2026-01-06T09:00:00Z'), tz), '2026-01-06');   // 04:00
  assert.equal(localDateOf(Date.parse('2026-01-06T04:59:00Z'), tz), '2026-01-05');   // 23:59
});

test('the day boundary holds across a clock change', () => {
  const tz = 'America/New_York';                       // clocks go forward at 02:00 on 8 March 2026
  assert.equal(localDateOf(Date.parse('2026-03-08T07:30:00Z'), tz), '2026-03-07');   // 03:30 after the jump
  assert.equal(localDateOf(Date.parse('2026-03-08T08:00:00Z'), tz), '2026-03-08');   // 04:00
  assert.equal(clockMinuteOf(Date.parse('2026-03-08T08:00:00Z'), tz), 240);
});

test('a boundary of zero means midnight', () => {
  assert.equal(localDateOf(Date.parse('2026-01-06T00:30:00Z'), 'UTC', 0), '2026-01-06');
  assert.equal(localDateOf(Date.parse('2026-01-06T00:30:00Z'), 'UTC'), '2026-01-05');
});
