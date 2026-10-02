import { test } from 'node:test';
import assert from 'node:assert/strict';
import { restoreEntry, restoreNotYet, saveEntry, saveNotYet, trashEntry, trashNotYet } from '../../src/record/ops/words.ts';
import { openSession } from '../../src/record/ops/session.ts';
import { openedRecord } from './helpers.ts';
import { stubCipher } from './stubCipher.ts';
import { guarded } from './txGuard.ts';

const cipher = () => guarded(stubCipher());

test('a diary page keeps the day it was first written on, and Save tapped twice makes one page', async () => {
  const { core, db, clock } = await openedRecord();
  await Promise.all([saveEntry(core, { id: 'e1', body: 'CANARY-TEST one' }), saveEntry(core, { id: 'e1', body: 'CANARY-TEST one' })]);
  assert.equal(await db.entries.count(), 1);
  clock.set('2026-01-09T09:00:00Z');
  await saveEntry(core, { id: 'e1', body: 'CANARY-TEST one, edited' });
  assert.deepEqual(core.session?.model.entries.get('e1'), { id: 'e1', date: '2026-01-05', body: 'CANARY-TEST one, edited' });
  assert.equal((await db.entries.get('e1'))?.local_date, '2026-01-05');
});

test('a page in the trash can be put back, but not edited while it is there', async () => {
  const { core } = await openedRecord();
  await saveEntry(core, { id: 'e1', body: 'CANARY-TEST' });
  assert.equal((await trashEntry(core, { id: 'e1' })).kind, 'Saved');
  assert.ok(core.session?.model.entries.get('e1')?.trashedAt !== undefined);
  assert.deepEqual(await saveEntry(core, { id: 'e1', body: 'CANARY-TEST changed' }), { kind: 'Invalid', reason: 'in the trash' });
  assert.equal((await restoreEntry(core, { id: 'e1' })).kind, 'Saved');
  assert.equal(core.session?.model.entries.get('e1')?.trashedAt, undefined);
  assert.deepEqual(await restoreEntry(core, { id: 'e1' }), { kind: 'Invalid', reason: 'not in the trash' });
});

test('after 7 days in the trash a page\'s words are wiped and only a tombstone remains', async () => {
  const { core, db, clock } = await openedRecord();
  await saveEntry(core, { id: 'old', body: 'CANARY-TEST old' });
  await trashEntry(core, { id: 'old' });
  clock.set('2026-01-07T09:00:00Z');
  await saveEntry(core, { id: 'new', body: 'CANARY-TEST new' });
  await trashEntry(core, { id: 'new' });
  clock.set('2026-01-12T09:01:00Z');                                       // 7 days and a minute after the first
  await core.lock();
  await openSession(core, cipher());
  const gone = await db.entries.get('old');
  assert.deepEqual(Object.keys(gone ?? {}).sort(), ['deleted_at', 'id', 'local_date', 'updated_at', 'updated_by']);
  assert.equal(core.session?.model.entries.has('old'), false);
  assert.ok(core.session?.model.entries.has('new'));                       // 5 days in: still in the trash
});

test('Not yet items go to the trash and are wiped the same way', async () => {
  const { core, db, clock } = await openedRecord();
  await saveNotYet(core, { id: 'n1', text: 'CANARY-TEST', why: 'CANARY-TEST why' });
  await trashNotYet(core, { id: 'n1' });
  await restoreNotYet(core, { id: 'n1' });
  await trashNotYet(core, { id: 'n1' });
  clock.set('2026-01-12T09:01:00Z');
  await core.lock();
  await openSession(core, cipher());
  assert.equal((await db.notyet.get('n1'))?.w, undefined);
  assert.equal(core.session?.model.notyet.size, 0);
});

test('an unlock with nothing in the trash changes nothing, not even the last-write stamp', async () => {
  const { core, clock } = await openedRecord();
  const before = core.session?.lastWriteMs;
  clock.set('2026-01-20T09:00:00Z');
  await core.lock();
  await openSession(core, cipher());
  assert.equal(core.session?.lastWriteMs, before);
});
