import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHabit } from '../../src/record/ops/habits.ts';
import { deleteCue, saveCue, type CueSave } from '../../src/record/ops/cues.ts';
import { openParts } from '../../src/record/payload.ts';
import { openedRecord } from './helpers.ts';
import { stubCipher } from './stubCipher.ts';
import { guarded } from './txGuard.ts';

const cue: CueSave = { id: 'c1', habitId: 'h-walk', kind: 'cue', text: 'Stand up and stretch', times: { at: [600] }, enabled: true, private: false };

async function withHabit() {
  const t = await openedRecord();
  await createHabit(t.core, { id: 'h-walk', name: 'CANARY-TEST walk', kind: 'tri', days: [0, 1, 2, 3, 4, 5, 6], asked: 'evening', target: {}, tier: 'focus' });
  return t;
}

test('editing a reminder keeps its first day, so its fade does not start again', async () => {
  const { core, clock } = await withHabit();
  await saveCue(core, cue);
  clock.set('2026-01-08T09:00:00Z');
  assert.equal((await saveCue(core, { ...cue, times: { at: [660] } })).kind, 'Saved');
  assert.equal(core.session?.model.cues.get('c1')?.createdOn, '2026-01-05');
});

test('a private reminder\'s words are stored under the words key, and a reminder that makes no sense is refused', async () => {
  const { core, db } = await withHabit();
  await saveCue(core, { ...cue, id: 'c2', text: 'CANARY-TEST private', private: true });
  const row = await db.cues.get('c2');
  const opened = await openParts(guarded(stubCipher()), 'cues', { id: 'c2' }, { r: row?.r, w: row?.w });
  assert.equal(opened.r?.text, undefined);
  assert.equal(opened.w?.text, 'CANARY-TEST private');
  assert.equal((await saveCue(core, { ...cue, id: 'c3', times: { every: 60, from: 180, to: 300 } })).kind, 'Invalid');   // across 04:00
  assert.equal((await saveCue(core, { ...cue, id: 'c4', kind: 'checkin' })).kind, 'Invalid');                           // a check-in has no habit
  assert.deepEqual(await saveCue(core, { ...cue, id: 'c5', habitId: 'nobody' }), { kind: 'Invalid', reason: 'no such habit' });
});

test('deleting a reminder leaves a tombstone with nothing locked', async () => {
  const { core, db } = await withHabit();
  await saveCue(core, cue);
  assert.equal((await deleteCue(core, { id: 'c1' })).kind, 'Saved');
  const row = await db.cues.get('c1');
  assert.equal(row?.r, undefined);
  assert.equal(row?.w, undefined);
  assert.ok(row?.deleted_at !== undefined);
  assert.equal(core.session?.model.cues.has('c1'), false);
});
