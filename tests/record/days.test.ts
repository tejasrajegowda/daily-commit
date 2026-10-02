import { test } from 'node:test';
import assert from 'node:assert/strict';
import { closeDay, reopenDay, saveDayWords } from '../../src/record/ops/days.ts';
import { createHabit } from '../../src/record/ops/habits.ts';
import { logObservation } from '../../src/record/ops/observations.ts';
import { openParts } from '../../src/record/payload.ts';
import { openedRecord } from './helpers.ts';
import { stubCipher } from './stubCipher.ts';
import { guarded } from './txGuard.ts';

test('closing a day records when, with a lights-out after midnight; a log after that is marked', async () => {
  const { core } = await openedRecord();
  await createHabit(core, { id: 'h-walk', name: 'CANARY-TEST walk', kind: 'tri', days: [0, 1, 2, 3, 4, 5, 6], asked: 'evening', target: {}, tier: 'focus' });
  assert.equal((await closeDay(core, { date: '2026-01-05', lightsOut: 1470 })).kind, 'Saved');
  const day = core.session?.model.days.get('2026-01-05');
  assert.equal(day?.lightsOut, 1470);
  assert.ok(day?.closedAt !== undefined);
  await logObservation(core, { habitId: 'h-walk', date: '2026-01-05', value: 'did' });
  assert.equal(core.session?.model.observations.get('h-walk|2026-01-05')?.editedAfterClose, true);
  assert.deepEqual(await closeDay(core, { date: '2026-01-05' }), { kind: 'Invalid', reason: 'already closed' });
  assert.equal((await closeDay(core, { date: '2026-01-04', lightsOut: 1700 })).kind, 'Invalid');    // after 03:59
});

test('reopening is counted, and a day two days back can no longer be closed or reopened', async () => {
  const { core, clock } = await openedRecord();
  await closeDay(core, { date: '2026-01-05' });
  assert.equal((await reopenDay(core, { date: '2026-01-05' })).kind, 'Saved');
  const day = core.session?.model.days.get('2026-01-05');
  assert.equal(day?.closedAt, undefined);
  assert.equal(day?.reopenedCount, 1);
  clock.set('2026-01-07T09:00:00Z');
  assert.deepEqual(await closeDay(core, { date: '2026-01-05' }), { kind: 'Sealed' });
});

test('a day\'s words are locked under the words key, apart from the rest of the day', async () => {
  const { core, db } = await openedRecord();
  await saveDayWords(core, { date: '2026-01-05', intent: 'CANARY-TEST intent' });
  await saveDayWords(core, { date: '2026-01-05', remark: 'CANARY-TEST remark' });
  assert.equal(core.session?.model.days.get('2026-01-05')?.intent, 'CANARY-TEST intent');   // the second save kept the first
  const row = await db.days.get('2026-01-05');
  const opened = await openParts(guarded(stubCipher()), 'days', { local_date: '2026-01-05' }, { r: row?.r, w: row?.w });
  assert.equal(opened.w?.intent, 'CANARY-TEST intent');
  assert.equal(opened.w?.remark, 'CANARY-TEST remark');
  assert.equal(opened.r?.intent, undefined);
  assert.equal(opened.r?.rest_day, false);
});
