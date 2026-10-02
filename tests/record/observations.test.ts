import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHabit, type NewHabit } from '../../src/record/ops/habits.ts';
import { clearObservation, logObservation, planDay } from '../../src/record/ops/observations.ts';
import { sheetNow } from '../../src/record/ops/common.ts';
import { rulesInput } from '../../src/record/read.ts';
import { openedRecord } from './helpers.ts';

const habit = (over: Partial<NewHabit> = {}): NewHabit => ({
  id: 'h-walk', name: 'CANARY-TEST walk', kind: 'tri', days: [0, 1, 2, 3, 4, 5, 6], asked: 'evening', target: {}, tier: 'focus', startedOn: '2026-01-01', ...over,
});

test('a value is logged, locked, and replaces a plan made for that day', async () => {
  const { core, db } = await openedRecord();
  await createHabit(core, habit());
  await planDay(core, { date: '2026-01-05', plans: [{ habitId: 'h-walk', reason: 'travelling' }] });
  assert.equal(core.session?.model.observations.get('h-walk|2026-01-05')?.planned, 'travelling');
  assert.equal((await logObservation(core, { habitId: 'h-walk', date: '2026-01-05', value: 'did' })).kind, 'Saved');
  const o = core.session?.model.observations.get('h-walk|2026-01-05');
  assert.equal(o?.value, 'did');
  assert.equal(o?.planned, undefined);
  assert.equal(o?.isBackfill, false);
  const row = await db.observations.get(['h-walk', '2026-01-05']);
  assert.deepEqual(Object.keys(row ?? {}).sort(), ['habit_id', 'local_date', 'r', 'updated_at', 'updated_by']);
});

test('yesterday can still be filled in, and is marked as filled in later; the day before is closed', async () => {
  const { core, clock } = await openedRecord();
  await createHabit(core, habit());
  clock.set('2026-01-06T09:00:00Z');
  assert.equal((await logObservation(core, { habitId: 'h-walk', date: '2026-01-05', value: 'partly' })).kind, 'Saved');
  assert.equal(core.session?.model.observations.get('h-walk|2026-01-05')?.isBackfill, true);
  assert.deepEqual(await logObservation(core, { habitId: 'h-walk', date: '2026-01-04', value: 'did' }), { kind: 'Sealed' });
});

test('a value that doesn\'t fit the habit, or a day it isn\'t asked, is refused', async () => {
  const { core } = await openedRecord();
  await createHabit(core, habit());
  await createHabit(core, habit({ id: 'h-bed', kind: 'time', tier: 'log', target: { band: 1410, part: 1470 }, days: [5, 6] }));
  assert.equal((await logObservation(core, { habitId: 'h-walk', date: '2026-01-05', value: 3 })).kind, 'Invalid');
  assert.equal((await logObservation(core, { habitId: 'h-bed', date: '2026-01-04', value: 1700 })).kind, 'Invalid');   // later than 03:59
  assert.deepEqual(await logObservation(core, { habitId: 'h-bed', date: '2026-01-05', value: 1470 }), { kind: 'Invalid', reason: 'not asked that day' });
  assert.equal((await logObservation(core, { habitId: 'h-bed', date: '2026-01-04', value: 1470 })).kind, 'Saved');     // the Sunday before, 00:30
});

test('a wake-up logged at 03:50 goes to the day ahead as 230, for a morning habit only', async () => {
  const { core, clock } = await openedRecord();
  await createHabit(core, habit({ id: 'h-up', kind: 'time', asked: 'morning', target: { band: 420, part: 450 } }));
  await createHabit(core, habit({ id: 'h-bed', kind: 'time', tier: 'log', target: { band: 1410, part: 1470 } }));
  clock.set('2026-01-06T03:50:00Z');                                         // still the 5th: before the boundary
  assert.equal((await logObservation(core, { habitId: 'h-up', date: '2026-01-06', value: 230 })).kind, 'Saved');
  assert.deepEqual(await logObservation(core, { habitId: 'h-bed', date: '2026-01-06', value: 1440 }), { kind: 'Sealed' });
  assert.deepEqual(await logObservation(core, { habitId: 'h-up', date: '2026-01-07', value: 230 }), { kind: 'Sealed' });
});

test('a sheet opened at 03:58 still saves the day before yesterday at 04:05, twice, but not at 04:15', async () => {
  const { core, clock } = await openedRecord();
  await createHabit(core, habit());
  clock.set('2026-01-07T03:58:00Z');                                         // the 6th, two minutes before the boundary
  const sheet = sheetNow(core);
  clock.set('2026-01-07T04:05:00Z');
  assert.equal((await logObservation(core, { habitId: 'h-walk', date: '2026-01-05', value: 'did', sheet })).kind, 'Saved');
  clock.set('2026-01-07T04:06:00Z');
  assert.equal((await logObservation(core, { habitId: 'h-walk', date: '2026-01-05', value: 'partly', sheet })).kind, 'Saved');
  clock.set('2026-01-07T04:15:00Z');
  assert.deepEqual(await logObservation(core, { habitId: 'h-walk', date: '2026-01-05', value: 'did', sheet }), { kind: 'Sealed' });
});

test('clearing leaves a tombstone with nothing locked, and logging again brings the same row back', async () => {
  const { core, db } = await openedRecord();
  await createHabit(core, habit());
  await logObservation(core, { habitId: 'h-walk', date: '2026-01-05', value: 'did' });
  assert.equal((await clearObservation(core, { habitId: 'h-walk', date: '2026-01-05' })).kind, 'Saved');
  const gone = await db.observations.get(['h-walk', '2026-01-05']);
  assert.equal(gone?.r, undefined);
  assert.equal(gone?.w, undefined);
  assert.equal(gone?.deleted_at, gone?.updated_at);
  assert.equal(core.session?.model.observations.has('h-walk|2026-01-05'), false);
  await logObservation(core, { habitId: 'h-walk', date: '2026-01-05', value: 'partly' });
  assert.equal(await db.observations.count(), 1);
  assert.equal((await db.observations.get(['h-walk', '2026-01-05']))?.deleted_at, undefined);
});

test('a day is planned ahead for habits and as a rest day, and a plan never covers a logged value', async () => {
  const { core } = await openedRecord();
  await createHabit(core, habit());
  await createHabit(core, habit({ id: 'h-read', kind: 'min', tier: 'log', target: { bar: 15 } }));
  assert.equal((await planDay(core, { date: '2026-02-10', plans: [{ habitId: 'h-walk', reason: 'meeting' }], restDay: true })).kind, 'Saved');
  assert.ok(core.session);
  const rules = rulesInput(core.session.model);
  assert.equal(rules.index.get('h-walk|2026-02-10')?.planned, 'meeting');
  assert.equal(rules.index.get('h-read|2026-02-10')?.planned, 'rest');       // the rest day reaches the rules
  await logObservation(core, { habitId: 'h-walk', date: '2026-01-05', value: 'did' });
  assert.deepEqual(await planDay(core, { date: '2026-01-05', plans: [{ habitId: 'h-walk', reason: 'unwell' }] }), { kind: 'Invalid', reason: 'already logged that day' });
  assert.deepEqual(await planDay(core, { date: '2026-01-03', restDay: true }), { kind: 'Sealed' });
});
