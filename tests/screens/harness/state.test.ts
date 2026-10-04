import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dateOfDay, nowOf, readState, START } from './state.ts';

test('the URL hash gives the screen, the variant, the time and the day, with defaults', () => {
  assert.deepEqual(readState(''), { screen: 'today', variant: '', minute: 780, day: 17 });
  assert.deepEqual(readState('#s=lock&v=own&t=06:05&age=60'), { screen: 'lock', variant: 'own', minute: 365, day: 60 });
});

test('a time or a day that is not a number falls back to the default', () => {
  assert.deepEqual(readState('#t=soon&age=x'), { screen: 'today', variant: '', minute: 780, day: 17 });
  assert.equal(readState('#t=25:00').minute, 780);
  assert.equal(readState('#age=0').day, 1);
});

test('day 1 is the start, a Monday, and the clock is that day at the given minute, in UTC', () => {
  assert.equal(START, '2026-01-05');
  assert.equal(new Date(`${START}T00:00:00Z`).getUTCDay(), 1);
  assert.equal(dateOfDay(1), START);
  assert.equal(dateOfDay(32), '2026-02-05');
  assert.equal(nowOf(readState('#t=06:05&age=2')), Date.UTC(2026, 0, 6, 6, 5));
});
