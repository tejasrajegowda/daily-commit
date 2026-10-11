import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dateOfDay, nowOf, readState, START } from './state.ts';

const NONE = { noLock: false, kept: undefined, handOff: undefined, ownCode: false };

test('the URL hash gives the screen, the variant, the time and the day, with defaults', () => {
  assert.deepEqual(readState(''), { screen: 'today', variant: '', minute: 780, day: 17, canary: false, start: START, ...NONE });
  assert.deepEqual(readState('#s=lock&v=own&t=06:05&age=60'), { screen: 'lock', variant: 'own', minute: 365, day: 60, canary: false, start: START, ...NONE });
});

test('a time or a day that is not a number falls back to the default', () => {
  assert.deepEqual(readState('#t=soon&age=x'), { screen: 'today', variant: '', minute: 780, day: 17, canary: false, start: START, ...NONE });
  assert.equal(readState('#t=25:00').minute, 780);
  assert.equal(readState('#age=0').day, 1);
  assert.equal(readState('#canary=1').canary, true);
});

test('day 1 is the start, a Monday, and the clock is that day at the given minute, in UTC', () => {
  assert.equal(START, '2026-01-05');
  assert.equal(new Date(`${START}T00:00:00Z`).getUTCDay(), 1);
  assert.equal(dateOfDay(1), START);
  assert.equal(dateOfDay(32), '2026-02-05');
  assert.equal(nowOf(readState('#t=06:05&age=2')), Date.UTC(2026, 0, 6, 6, 5));
});

test('nl, kept, ho and oc are read, and an unknown hand-off is ignored', () => {
  assert.equal(readState('#nl=1').noLock, true);
  assert.equal(readState('#kept=1').kept, true);
  assert.equal(readState('#kept=0').kept, false);
  assert.equal(readState('#ho=export').handOff, 'export');
  assert.equal(readState('#ho=restore').handOff, 'restore');
  assert.equal(readState('#ho=fingerprint').handOff, 'fingerprint');
  assert.equal(readState('#ho=nope').handOff, undefined);
  assert.equal(readState('#oc=1').ownCode, true);
});

test('a handed-in record moves day 1 to its own start', () => {
  const state = readState('#t=06:05&age=17', '2026-09-07');
  assert.equal(dateOfDay(17, state.start), '2026-09-23');
  assert.equal(nowOf(state), Date.UTC(2026, 8, 23, 6, 5));
});
