import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Secret } from '../../src/vault/cipher.ts';
import { openRecord, type RecordCore } from '../../src/record/core.ts';
import type { RecordDb } from '../../src/record/db.ts';
import { jsonBytes } from '../../src/record/bytes.ts';
import { firstRun } from '../../src/record/ops/firstRun.ts';
import { setSetting } from '../../src/record/ops/settings.ts';
import { rulesInput } from '../../src/record/read.ts';
import { BODY_TABLES, bodyJson, gunzip, gzip, parseBody, type StoredRows } from '../../src/record/backup/body.ts';
import { COPY_LIFE_MS, KEEP_COPIES, keepCopy, pruneCopies } from '../../src/record/backup/copies.ts';
import { exportBackup } from '../../src/record/backup/export.ts';
import { frame, readFrame } from '../../src/record/backup/format.ts';
import { restore } from '../../src/record/backup/restore.ts';
import { LATEST } from '../../src/record/backup/snapshot.ts';
import { closeSession } from '../../src/record/ops/session.ts';
import { filledRecord, freshDb } from './helpers.ts';
import { failAtRow } from './faults.ts';
import { SETTINGS, VAULT, WRAPPERS, testClock } from './fixtures.ts';
import { memoryFiles } from './memoryFiles.ts';
import { STUB_SECRETS, stubBackup } from './stubBackup.ts';
import { stubCipher } from './stubCipher.ts';
import { guarded, guardedBackup } from './txGuard.ts';

const PASS: Secret = { method: 'passphrase', text: STUB_SECRETS.passphrase };
const OPTS = { appVersion: '0.1.0', iv: new Uint8Array(12).fill(7) };
const opener = () => guardedBackup(stubBackup());
const REPLACE = (files = memoryFiles().files) => ({ files, appVersion: '0.1.0' });

async function exportOf(core: RecordCore): Promise<Uint8Array> {
  const result = await exportBackup(core, OPTS);
  if (result.kind !== 'Saved') throw new Error(result.kind);
  return result.value.bytes;
}

/** An empty record on a fresh database. */
function emptyRecord(db: RecordDb = freshDb(), now = testClock('2026-01-06T20:00:00Z').now) {
  return { db, core: openRecord({ db, now }) };
}

const sessionOf = (core: RecordCore) => core.session;
const rowsOf = async (db: RecordDb) => Object.fromEntries(await Promise.all(BODY_TABLES.map(async t => [t, await db.table(t).toArray()] as const)));
const isEmpty = async (db: RecordDb) => (await Promise.all(db.tables.map(t => t.count()))).every(n => n === 0);

/** Opens a file with the stand-in, lets a test change its body or header, and seals it again. */
async function refile(file: Uint8Array, edit: (tables: Record<string, object[]>, header: Record<string, unknown>) => void): Promise<Uint8Array> {
  const f = readFrame(file);
  const opened = await stubBackup().openBody(f.headerBytes, f.iv, f.ct, f.header.wrappers, PASS);
  const tables = structuredClone(parseBody(await gunzip(opened.body))) as unknown as Record<string, object[]>;
  const header = structuredClone(f.header) as unknown as Record<string, unknown>;
  edit(tables, header);
  const head = jsonBytes(header);
  return frame(head, await stubBackup().sealBody(await gzip(bodyJson(tables as unknown as StoredRows)), head, f.iv));
}

test('a backup restores into an empty database: every row, both wrappers, a new device id, and the same record once unlocked', async () => {
  const a = await filledRecord();
  const file = await exportOf(a.core);
  const b = emptyRecord();
  assert.deepEqual(await restore(b.core, { file, secret: PASS, backupCipher: opener() }), { kind: 'Restored' });
  assert.deepEqual(await rowsOf(b.db), await rowsOf(a.db));                              // senses 1 and 2
  assert.deepEqual(await b.db.wrappers.toArray(), await a.db.wrappers.toArray());          // sense 3
  const device = await b.db.device.get('device_id');
  assert.ok(device && device.value !== (await a.db.device.get('device_id'))?.value);
  assert.equal(b.core.session, undefined);                                                  // a restore ends locked
  await b.core.unlock(guarded(stubCipher()));
  const sa = sessionOf(a.core), sb = sessionOf(b.core);                                     // read afresh: the lock check above narrowed it
  assert.ok(sa && sb);
  assert.deepEqual(rulesInput(sb.model), rulesInput(sa.model));                            // sense 5
  assert.deepEqual(sb.model.settings, sa.model.settings);
});

test('export, restore, export again: the same bytes, with the time and the IV fixed', async () => {
  const a = await filledRecord();
  const first = await exportOf(a.core);
  const b = emptyRecord(freshDb(), a.clock.now);
  await restore(b.core, { file: first, secret: PASS, backupCipher: opener() });
  await b.core.unlock(guarded(stubCipher()), opener());
  assert.deepEqual(await exportOf(b.core), first);                                          // sense 6
});

test('the checked-in v1 fixture restores, with the recovery code', async () => {
  const file = new Uint8Array(readFileSync(join(import.meta.dirname, 'fixtures', 'backup-v1.fixture.bin')));
  const b = emptyRecord();
  assert.deepEqual(await restore(b.core, { file, secret: { method: 'recovery', text: STUB_SECRETS.recovery }, backupCipher: opener() }), { kind: 'Restored' });
  await b.core.unlock(guarded(stubCipher()));
  assert.equal(b.core.session?.model.habits.size, 1);
});

test('a record with data is refused unless "replace everything", saying when the file is another vault\'s; into an empty database any vault restores', async () => {
  const a = await filledRecord();
  const file = await exportOf(a.core);
  const same = await filledRecord();
  const before = await rowsOf(same.db);
  assert.deepEqual(await restore(same.core, { file, secret: PASS, backupCipher: opener() }), { kind: 'HasData', otherVault: false });
  assert.deepEqual(await rowsOf(same.db), before);
  const other = emptyRecord();
  const setup = { cipher: guarded(stubCipher()), vault: { ...VAULT, vault_id: 'another-vault-id' }, wrappers: WRAPPERS, settings: SETTINGS };
  assert.equal((await firstRun(other.core, setup)).kind, 'Saved');
  assert.deepEqual(await restore(other.core, { file, secret: PASS, backupCipher: opener() }), { kind: 'HasData', otherVault: true });
  await other.core.lock();
  await other.core.unlock(guarded(stubCipher()), opener());
  const otherFile = await exportOf(other.core);
  const empty = emptyRecord();
  assert.deepEqual(await restore(empty.core, { file: otherFile, secret: PASS, backupCipher: opener() }), { kind: 'Restored' });
  assert.equal((await empty.db.vault.get('main'))?.vault_id, 'another-vault-id');
});

test('"replace everything" keeps a safety copy first, then replaces every row and keeps this device', async () => {
  const a = await filledRecord();
  const file = await exportOf(a.core);
  const c = await filledRecord();
  await setSetting(c.core, 'wakePlan', 400);
  const before = await rowsOf(c.db);
  const device = await c.db.device.get('device_id');
  const m = memoryFiles();
  assert.deepEqual(await restore(c.core, { file, secret: PASS, backupCipher: opener(), replace: REPLACE(m.files) }), { kind: 'Restored' });
  assert.equal(c.core.session, undefined);
  assert.deepEqual(await rowsOf(c.db), await rowsOf(a.db));
  assert.deepEqual(await c.db.device.get('device_id'), device);
  const copies = [...m.store.keys()].filter(p => p.startsWith('safety/'));
  assert.deepEqual([...m.store.keys()].filter(p => !p.startsWith('safety/')), [LATEST]);   // the restored file is the latest snapshot
  assert.equal(copies.length, 1);
  assert.match(copies[0] ?? '', /^safety\/\d{13}\.dcbak$/);
  const safety = readFrame(m.store.get(copies[0] ?? '') ?? new Uint8Array());
  const opened = await stubBackup().openBody(safety.headerBytes, safety.iv, safety.ct, safety.header.wrappers, PASS);
  assert.deepEqual(parseBody(await gunzip(opened.body)), before);
});

test('"replace everything" needs the record open; nothing changes while it is locked', async () => {
  const a = await filledRecord();
  const file = await exportOf(a.core);
  const c = await filledRecord();
  await c.core.lock();
  const before = await rowsOf(c.db);
  const m = memoryFiles();
  assert.deepEqual(await restore(c.core, { file, secret: PASS, backupCipher: opener(), replace: REPLACE(m.files) }), { kind: 'Locked' });
  assert.deepEqual(await rowsOf(c.db), before);
  assert.equal(m.store.size, 0);
});

test('a damaged file, a wrong secret or a newer format is refused before anything happens, even with "replace everything"', async () => {
  const a = await filledRecord();
  const file = await exportOf(a.core);
  const tooLong = file.slice();
  new DataView(tooLong.buffer).setUint32(4, tooLong.length);
  const flipped = file.slice();
  const at = flipped.length - 20;
  flipped[at] = (flipped[at] ?? 0) ^ 1;
  const f = readFrame(file);
  const cases: [string, Uint8Array, Secret, string][] = [
    ['cut short', file.slice(0, Math.floor(file.length / 2)), PASS, 'damaged'],
    ['one byte flipped', flipped, PASS, 'damaged'],
    ['a header length beyond the file', tooLong, PASS, 'damaged'],
    ['a wrong passphrase', file, { method: 'passphrase', text: 'CANARY-WRONG' }, 'wrong-secret'],
    ['a newer format', frame(jsonBytes({ ...f.header, format_version: 2 }), f.ct), PASS, 'newer-app'],
  ];
  const c = await filledRecord();
  const before = await rowsOf(c.db);
  const m = memoryFiles();
  for (const [what, bad, secret, reason] of cases) {
    const empty = emptyRecord();
    assert.deepEqual(await restore(empty.core, { file: bad, secret, backupCipher: opener() }), { kind: 'Refused', reason }, what);
    assert.ok(await isEmpty(empty.db), what);
    assert.deepEqual(await restore(c.core, { file: bad, secret, backupCipher: opener(), replace: REPLACE(m.files) }), { kind: 'Refused', reason }, what);
  }
  assert.deepEqual(await rowsOf(c.db), before);
  assert.ok(c.core.session, 'a refused file never locks the record');
  assert.equal(m.store.size, 0);
});

test('a file that contradicts itself is damaged; a value from a newer app needs a newer app', async () => {
  const a = await filledRecord();
  const file = await exportOf(a.core);
  const edits: [string, (t: Record<string, object[]>, h: Record<string, unknown>) => void, string][] = [
    ['the header and the vault disagree', (_t, h) => { h.generation = 2; }, 'damaged'],
    ['a tombstone carrying a locked value', t => { (t.cues?.[0] as Record<string, unknown>).r = { v: 1, k: 'k', iv: 'i', ct: 'c' }; }, 'damaged'],
    ['a value under another vault\'s key', t => { (t.settings?.[0] as { r: { k: string } }).r.k = 'not-this-vault'; }, 'damaged'],
    ['a value moved to another row', t => {
      const [x, y] = t.settings as { r: unknown }[];
      if (x && y) [x.r, y.r] = [y.r, x.r];
    }, 'damaged'],
    ['a value from a newer app', t => { (t.settings?.[0] as { r: { v: number } }).r.v = 2; }, 'newer-app'],
  ];
  for (const [what, edit, reason] of edits) {
    const empty = emptyRecord();
    assert.deepEqual(await restore(empty.core, { file: await refile(file, edit), secret: PASS, backupCipher: opener() }), { kind: 'Refused', reason }, what);
    assert.ok(await isEmpty(empty.db), what);
  }
});

test('a failure at any row of the write leaves the database as it was; a full disk is told apart', async () => {
  const a = await filledRecord();
  const file = await exportOf(a.core);
  for (const n of [1, 5, 14]) {                       // 14 body rows, then 2 wrappers and the device id
    const db = freshDb();
    db.use(failAtRow(n));
    await assert.rejects(restore(emptyRecord(db).core, { file, secret: PASS, backupCipher: opener() }), /injected failure/, `row ${n}`);
    assert.ok(await isEmpty(db), `row ${n}`);
  }
  const db = freshDb();
  db.use(failAtRow(3, () => new DOMException('disk full', 'QuotaExceededError')));
  assert.deepEqual(await restore(emptyRecord(db).core, { file, secret: PASS, backupCipher: opener() }), { kind: 'QuotaFull' });
  assert.ok(await isEmpty(db));
});

test('private copies keep at most two, and each goes after 7 days', async () => {
  const m = memoryFiles();
  const day = 86_400_000, t0 = Date.UTC(2026, 0, 5);
  for (const i of [0, 1, 2]) await keepCopy(m.files, 'safety', t0 + i * day, 'dcbak', Uint8Array.of(i));
  assert.equal(KEEP_COPIES, 2);
  assert.deepEqual([...m.store.keys()].sort(), [`safety/${t0 + day}.dcbak`, `safety/${t0 + 2 * day}.dcbak`]);
  await pruneCopies(m.files, 'safety', t0 + day + COPY_LIFE_MS);
  assert.deepEqual([...m.store.keys()], [`safety/${t0 + 2 * day}.dcbak`]);
});

test('after "replace everything", the restored file is the latest snapshot, not the data it replaced', async () => {
  const a = await filledRecord();
  const file = await exportOf(a.core);
  const c = await filledRecord();
  const m = memoryFiles();
  c.clock.advance(3_600_000);
  assert.equal(await closeSession(c.core, { files: m.files, sleep: () => new Promise<void>(() => {}), appVersion: '0.1.0' }), 'written');
  await c.core.unlock(guarded(stubCipher()), opener());
  assert.deepEqual(await restore(c.core, { file, secret: PASS, backupCipher: opener(), replace: REPLACE(m.files) }), { kind: 'Restored' });
  assert.deepEqual(m.store.get(LATEST), file);
});

test('a private copy dated well ahead of the clock goes too; one only a little ahead is kept', async () => {
  const m = memoryFiles();
  const t0 = Date.UTC(2026, 0, 5);
  await keepCopy(m.files, 'safety', t0 + 30 * 86_400_000, 'dcbak', Uint8Array.of(1));   // made while the clock was a month ahead
  await keepCopy(m.files, 'safety', t0 + 3_600_000, 'dcbak', Uint8Array.of(2));         // the clock since set back an hour
  await pruneCopies(m.files, 'safety', t0);
  assert.deepEqual([...m.store.keys()], [`safety/${t0 + 3_600_000}.dcbak`]);
});