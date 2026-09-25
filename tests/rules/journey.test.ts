import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dayNumber, hasOpened } from '../../src/rules/journey.ts';

test('the first day is day 1, and the count never goes below it', () => {
  assert.equal(dayNumber('2026-01-05', '2026-01-05'), 1);
  assert.equal(dayNumber('2026-01-05', '2026-03-05'), 60);
  assert.equal(dayNumber('2026-01-05', '2026-01-01'), 1);
});

test('views open on the day announced, not before', () => {
  assert.equal(hasOpened('timeTrend', 20), false);
  assert.equal(hasOpened('timeTrend', 21), true);
  assert.equal(hasOpened('monthlyReview', 59), false);
  assert.equal(hasOpened('monthlyReview', 60), true);
});
