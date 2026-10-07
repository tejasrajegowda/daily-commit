import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Model } from '../../../src/record/model.ts';
import { freshDb } from '../../record/helpers.ts';
import { dateOfDay, readState } from './state.ts';
import { FIXTURE_HABITS, seedRecord } from './seed.ts';

test('the fixture has ten habits: four kinds, three in Focus, a weekday-only one, a night-asked time habit', () => {
  assert.equal(FIXTURE_HABITS.length, 10);
  assert.deepEqual(new Set(FIXTURE_HABITS.map(h => h.kind)), new Set(['time', 'tri', 'min', 'mood']));
  assert.equal(FIXTURE_HABITS.filter(h => h.tier === 'focus').length, 3);
  assert.ok(FIXTURE_HABITS.some(h => h.days.length === 5));
  assert.ok(FIXTURE_HABITS.some(h => h.id === 'h-bed' && h.asked === 'evening' && h.kind === 'time'));
});

test('seeding day 40 leaves the record open on day 40, the late starter begins on day 30, some days were never opened, and every run draws the same history', async () => {
  const a = await seedRecord(freshDb(), readState('#age=40&t=09:00'));
  const b = await seedRecord(freshDb(), readState('#age=40&t=09:00'));
  const model = a.core.session?.model;
  const other = b.core.session?.model;
  assert.ok(model && other);
  assert.equal(model.habits.size, 10);
  assert.equal(model.habits.get('h-stretch')?.periods[0]?.from, dateOfDay(30));
  assert.ok([...model.observations.values()].every(o => o.date < dateOfDay(40)));
  assert.ok([...model.observations.values()].every(o => o.habitId !== 'h-stretch' || o.date >= dateOfDay(30)));
  const values = (m: Model) => [...m.observations.values()].map(o => `${o.habitId}|${o.date}|${String(o.value)}`).sort();
  assert.deepEqual(values(model), values(other));
  assert.ok(model.days.size > 25 && model.days.size < 39);
  assert.match(a.recoveryCode, /^([0-9A-Z]{5} ){8}[0-9A-Z*~$=]$/);
});

test('before day 30 the late starter is not in the record yet', async () => {
  const { core } = await seedRecord(freshDb(), readState('#age=10'));
  assert.equal(core.session?.model.habits.has('h-stretch'), false);
});
