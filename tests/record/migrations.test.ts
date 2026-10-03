import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { RowCipher } from '../../src/vault/cipher.ts';
import { TABLE_TAGS } from '../../src/vault/tags.ts';
import type { RecordDb } from '../../src/record/db.ts';
import { parseJsonBytes } from '../../src/record/bytes.ts';
import { runMigrations } from '../../src/record/migrations.ts';
import { openSession } from '../../src/record/ops/session.ts';
import { TRASH_MS, saveNotYet, sweepTrash, trashNotYet } from '../../src/record/ops/words.ts';
import { filledRecord } from './helpers.ts';
import { stubCipher } from './stubCipher.ts';
import { guarded } from './txGuard.ts';
import { TEST_V2 } from './v2.ts';

/** The invented record with four Not yet items: three live, one wiped to a tombstone. Locked. */
async function withNotYet() {
  const t = await filledRecord();
  for (const id of ['n-a', 'n-b', 'n-gone']) assert.equal((await saveNotYet(t.core, { id, text: 'CANARY-TEST' })).kind, 'Saved');
  await trashNotYet(t.core, { id: 'n-gone' });
  t.clock.advance(TRASH_MS + 60_000);
  assert.deepEqual(await sweepTrash(t.core), { kind: 'Saved', value: 1 });
  await t.core.lock();
  return t;
}

/** A Not yet item's words, opened straight from storage. */
async function words(db: RecordDb, id: string) {
  const row = await db.notyet.get(id);
  return row?.w ? (parseJsonBytes(await stubCipher().open({ table: TABLE_TAGS.notyet, id, slot: 'w' }, row.w)) as { text: string; pv: number }) : undefined;
}

const LIVE = ['n-a', 'n-b', 'n-later'];

test('a locked-value change reaches every live row once, keeps the stamps, skips tombstones, and is marked done', async () => {
  const { core, db } = await withNotYet();
  const before = await db.notyet.toArray();
  assert.equal(await runMigrations(core, guarded(stubCipher()), [TEST_V2], 2), 3);
  for (const id of LIVE) {
    const w = await words(db, id);
    assert.equal(w?.pv, 2, id);
    assert.match(w?.text ?? '', /^CANARY-TEST(?: later)? \(v2\)$/, id);
  }
  const after = await db.notyet.toArray();
  assert.deepEqual(after.map(r => [r.id, r.updated_at, r.updated_by]), before.map(r => [r.id, r.updated_at, r.updated_by]));
  assert.deepEqual(after.find(r => r.id === 'n-gone'), before.find(r => r.id === 'n-gone'));
  assert.ok((await db.migrations.get(TEST_V2.id))?.done_at !== undefined);
  assert.equal(await runMigrations(core, guarded(stubCipher()), [TEST_V2], 2), 0);
});

test('stopped part-way, it carries on from its cursor and changes nothing twice', async () => {
  const { core, db } = await withNotYet();
  const rows = guarded(stubCipher());
  let seals = 0;
  const flaky: RowCipher = {
    open: rows.open,
    seal: (ctx, plain) => { if (++seals === 3) throw new Error('stopped'); return rows.seal(ctx, plain); },
  };
  await assert.rejects(runMigrations(core, flaky, [TEST_V2], 2), /stopped/);
  assert.ok((await db.migrations.get(TEST_V2.id))?.cursor, 'the first batch and its cursor were kept');
  assert.equal(await runMigrations(core, guarded(stubCipher()), [TEST_V2], 2), 1);
  for (const id of LIVE) assert.doesNotMatch((await words(db, id))?.text ?? '', /\(v2\).*\(v2\)/, id);
});

test('a row already at the new version is skipped, so a restore can run every change again', async () => {
  const { core, db } = await withNotYet();
  await runMigrations(core, guarded(stubCipher()), [TEST_V2], 2);
  await db.migrations.clear();                                          // what a restore does
  assert.equal(await runMigrations(core, guarded(stubCipher()), [TEST_V2], 2), 0);
});

test('openSession runs the changes before it opens anything', async () => {
  const { core, db } = await withNotYet();
  // this app reads payload version 1 only, so a v2 value refusing to open shows the change ran first
  await assert.rejects(openSession(core, guarded(stubCipher()), undefined, [TEST_V2]), { failure: 'newer-app' });
  assert.equal((await words(db, 'n-a'))?.pv, 2);
  assert.equal(core.session, undefined);
});
