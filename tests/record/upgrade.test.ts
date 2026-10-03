import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { openRecord } from '../../src/record/core.ts';
import { openDb, upgradeRow, type StorageDeps } from '../../src/record/db.ts';
import { parseJsonBytes } from '../../src/record/bytes.ts';
import { openStorage, upgradeTables } from '../../src/record/upgrade.ts';
import { gunzip } from '../../src/record/backup/body.ts';
import { COPY_LIFE_MS } from '../../src/record/backup/copies.ts';
import { restore } from '../../src/record/backup/restore.ts';
import { memoryFiles } from './memoryFiles.ts';
import { STUB_SECRETS, stubBackup } from './stubBackup.ts';
import { stubCipher } from './stubCipher.ts';
import { guarded, guardedBackup } from './txGuard.ts';
import { TEST_SCHEMAS } from './v2.ts';

const FIXTURES = join(import.meta.dirname, 'fixtures');
const T0 = Date.UTC(2026, 0, 10);
const now = () => T0;
const freshDeps = (): StorageDeps => ({ name: 'daily-commit-test', indexedDB: new IDBFactory(), IDBKeyRange });
const fixture = () => (JSON.parse(readFileSync(join(FIXTURES, 'db-v1.fixture.json'), 'utf8')) as { tables: Record<string, Record<string, unknown>[]> }).tables;

/** A schema v1 database holding the fixture's rows, closed again. */
async function loadV1(deps: StorageDeps) {
  const tables = fixture();
  const db = openDb(deps);
  await db.transaction('rw', db.tables, async () => {
    for (const [name, rows] of Object.entries(tables)) await db.table(name).bulkAdd(rows);
  });
  db.close();
  return tables;
}

test('a new phone opens at the latest schema, and no copy is kept', async () => {
  const m = memoryFiles();
  const opened = await openStorage(freshDeps(), m.files, now);
  assert.equal(opened.kind, 'Ready');
  if (opened.kind === 'Ready') assert.equal(opened.db.verno, 1);
  assert.equal(m.store.size, 0);
});

test('an older database is copied raw, then upgraded on plain fields only, and every row still opens', async () => {
  const deps = freshDeps();
  const tables = await loadV1(deps);
  const m = memoryFiles();
  const opened = await openStorage(deps, m.files, now, TEST_SCHEMAS);
  if (opened.kind !== 'Ready') throw new Error(opened.kind);
  assert.equal(opened.db.verno, 2);
  assert.deepEqual([...m.store.keys()], [`preupgrade/${T0}.json.gz`]);
  const copy = parseJsonBytes(await gunzip(m.store.get(`preupgrade/${T0}.json.gz`) ?? new Uint8Array())) as { schema_version: number; tables: unknown };
  assert.equal(copy.schema_version, 1);
  assert.deepEqual(copy.tables, Object.fromEntries(Object.entries(tables).filter(([name]) => name !== 'device')));
  const entries = (await opened.db.entries.toArray()) as unknown as Record<string, unknown>[];
  assert.deepEqual(entries.map(e => e.month), ['2026-01']);
  assert.deepEqual(entries.map(e => { const copied = { ...e }; delete copied.month; return copied; }), tables.entries);
  const core = openRecord({ db: opened.db, now });
  await core.unlock(guarded(stubCipher()));
  assert.equal(core.session?.model.entries.size, 1);
});

test('a database from a newer app is refused, and nothing is copied or changed', async () => {
  const deps = freshDeps();
  const newer = openDb(deps, TEST_SCHEMAS);
  await newer.open();
  newer.close();
  const m = memoryFiles();
  assert.deepEqual(await openStorage(deps, m.files, now), { kind: 'AppTooOld' });
  assert.equal(m.store.size, 0);
  assert.deepEqual((await deps.indexedDB.databases()).map(d => d.version), [20]);
});

test('private copies older than 7 days go at app start', async () => {
  const m = memoryFiles();
  m.store.set(`preupgrade/${T0 - COPY_LIFE_MS}.json.gz`, Uint8Array.of(1));
  m.store.set(`safety/${T0 - COPY_LIFE_MS}.dcbak`, Uint8Array.of(2));
  m.store.set(`safety/${T0 - 1000}.dcbak`, Uint8Array.of(3));
  await openStorage(freshDeps(), m.files, now);
  assert.deepEqual([...m.store.keys()], [`safety/${T0 - 1000}.dcbak`]);
});

test('a plain upgrade may not touch a locked value, and the importer uses the same functions', () => {
  assert.throws(() => upgradeRow(row => ({ ...row, r: undefined }), { id: 'x', r: { v: 1 } }), /may not touch a locked value/);
  const tables = { entries: [{ id: 'e', local_date: '2026-02-03' }], habits: [{ id: 'h' }] };
  assert.deepEqual(upgradeTables(tables, 1, TEST_SCHEMAS), { entries: [{ id: 'e', local_date: '2026-02-03', month: '2026-02' }], habits: [{ id: 'h' }] });
  assert.deepEqual(upgradeTables(tables, 2, TEST_SCHEMAS), tables);
});

test('a v1 backup restores into a v2 database, its rows brought up to v2', async () => {
  const opened = await openStorage(freshDeps(), memoryFiles().files, now, TEST_SCHEMAS);
  if (opened.kind !== 'Ready') throw new Error(opened.kind);
  const file = new Uint8Array(readFileSync(join(FIXTURES, 'backup-v1.fixture.bin')));
  const result = await restore(openRecord({ db: opened.db, now }), {
    file, secret: { method: 'passphrase', text: STUB_SECRETS.passphrase }, backupCipher: guardedBackup(stubBackup()), schemas: TEST_SCHEMAS,
  });
  assert.deepEqual(result, { kind: 'Restored' });
  assert.deepEqual(((await opened.db.entries.toArray()) as unknown as Record<string, unknown>[]).map(e => e.month), ['2026-01']);
});
