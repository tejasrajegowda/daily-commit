import { test } from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';
import { BackupError, type Secret } from '../../src/vault/cipher.ts';
import { openRecord, type RecordCore } from '../../src/record/core.ts';
import type { RecordDb } from '../../src/record/db.ts';
import type { ChangeRow } from '../../src/record/rows.ts';
import { jsonBytes } from '../../src/record/bytes.ts';
import { CHANGE_LINE_VERSION, openLine, sealLine } from '../../src/record/changes.ts';
import { closeSession, openSession } from '../../src/record/ops/session.ts';
import { setSetting } from '../../src/record/ops/settings.ts';
import { gunzip, parseBody } from '../../src/record/backup/body.ts';
import { exportBackup } from '../../src/record/backup/export.ts';
import { FORMAT, LOG_FORMAT, frame, readFrame, type BackupHeader } from '../../src/record/backup/format.ts';
import { LOG_ARCHIVE, LOG_DIR, parseMonth } from '../../src/record/backup/monthLog.ts';
import { restore } from '../../src/record/backup/restore.ts';
import { LATEST } from '../../src/record/backup/snapshot.ts';
import { filledRecord, freshDb } from './helpers.ts';
import { memoryFiles } from './memoryFiles.ts';
import { STUB_SECRETS, stubBackup } from './stubBackup.ts';
import { stubCipher } from './stubCipher.ts';
import { guarded, guardedBackup } from './txGuard.ts';

// The automatic copy carries this month's change-log lines; each finished month is sealed once into
// its own file. The one rule: every line is in latest.dcbak or in a month file, at every moment.

const PASS: Secret = { method: 'passphrase', text: STUB_SECRETS.passphrase };
const never = () => new Promise<void>(() => {});
const reopen = (core: RecordCore) => openSession(core, guarded(stubCipher()), guardedBackup(stubBackup()));
const close = (core: RecordCore, files: ReturnType<typeof memoryFiles>['files']) => closeSession(core, { files, sleep: never, appVersion: '0.1.0' });
const JAN = '2026-01.dclog';
const FEB_STARTS = Date.UTC(2026, 1, 1, 4);                 // the fixtures' day starts at 04:00 UTC

/** The ids of the lines a backup or a month file holds, opened with the stand-in. */
async function idsIn(file: Uint8Array | undefined, format: BackupHeader['format'] = FORMAT): Promise<string[]> {
  if (!file) throw new Error('no such file');
  const f = readFrame(file, format);
  const opened = await stubBackup().openBody(f.headerBytes, f.iv, f.ct, f.header.wrappers, PASS);
  const body = await gunzip(opened.body);
  const rows = format === LOG_FORMAT ? parseMonth(body) : (parseBody(body, f.header.schema_version).changes as readonly ChangeRow[]);
  return rows.map(r => r.id).sort();
}
const ids = async (db: RecordDb, keep: (line: ChangeRow) => boolean = () => true) => (await db.changes.toArray()).filter(keep).map(r => r.id).sort();
const cursorOf = async (db: RecordDb) => (await db.device.get(LOG_ARCHIVE))?.value;

/** Each lock changes one setting, so it seals a snapshot. */
function changer(core: RecordCore) {
  let n = 400;
  return async () => {
    await reopen(core);
    const saved = await setSetting(core, 'wakePlan', n++);
    if (saved.kind !== 'Saved') throw new Error(saved.kind);
  };
}

/** A January record locked once, then a change in February. */
async function intoFebruary() {
  const t = await filledRecord();                           // its clock ends 2026-01-06 20:00
  const m = memoryFiles();
  const change = changer(t.core);
  assert.equal(await close(t.core, m.files), 'written');
  const january = await ids(t.db);
  t.clock.set('2026-02-02T10:00:00Z');
  await change();
  return { ...t, m, change, january };
}

test('the first snapshot of a new app month seals the month just finished into its own file; that lock\'s latest still holds every line, the next only the new month\'s', async () => {
  const { core, db, m, change, january } = await intoFebruary();
  assert.equal(await close(core, m.files), 'written');
  assert.deepEqual(await idsIn(m.store.get(`${LOG_DIR}/${JAN}`), LOG_FORMAT), january);
  assert.deepEqual(await idsIn(m.store.get(LATEST)), await ids(db));
  await change();
  m.log.length = 0;
  assert.equal(await close(core, m.files), 'written');
  assert.deepEqual(await idsIn(m.store.get(LATEST)), await ids(db, l => (l.at ?? 0) >= FEB_STARTS));
  assert.ok((await idsIn(m.store.get(LATEST))).length > 0);
  assert.deepEqual(m.log.filter(c => c.includes('.dclog')), [], 'a month file is written once, never again');
});

test('a month file that fails to write leaves the cursor: latest keeps every line, and the next lock writes it', async () => {
  const { core, db, m, change, january } = await intoFebruary();
  m.failOn('write tmp/month.dclog');
  assert.equal(await close(core, m.files), 'written');
  assert.equal(m.store.has(`${LOG_DIR}/${JAN}`), false);
  assert.equal(await cursorOf(db), undefined);
  assert.deepEqual(await idsIn(m.store.get(LATEST)), await ids(db));      // its sealing came before the file was written
  m.failOn(undefined);
  await change();
  assert.equal(await close(core, m.files), 'written');
  assert.deepEqual(await idsIn(m.store.get(`${LOG_DIR}/${JAN}`), LOG_FORMAT), january);
});

test('a cursor whose month file is gone is not trusted: latest holds every line again, and the month is sealed again', async () => {
  const { core, db, m, change, january } = await intoFebruary();
  await close(core, m.files);
  m.store.delete(`${LOG_DIR}/${JAN}`);
  await change();
  assert.equal(await close(core, m.files), 'written');
  assert.deepEqual(await idsIn(m.store.get(LATEST)), await ids(db));
  assert.deepEqual(await idsIn(m.store.get(`${LOG_DIR}/${JAN}`), LOG_FORMAT), january);
});

test('a clock set back into the archived month: a new change\'s line is stamped after the cursor, so the next latest holds it', async () => {
  const { core, db, clock, m, change } = await intoFebruary();
  await close(core, m.files);
  clock.set('2026-01-20T10:00:00Z');
  await change();
  const newest = (await db.changes.orderBy('at').last())?.id;
  assert.equal(await close(core, m.files), 'written');
  assert.ok(newest && (await idsIn(m.store.get(LATEST))).includes(newest));
});

test('a line newer than every row (a restore\'s or baseline\'s) still sets the floor: the next stamp comes after it', async () => {
  const { core, db, clock } = await filledRecord();
  const ahead = clock.now() + 30 * 86_400_000;
  await db.changes.add({ id: 'CANARY-line', at: ahead });     // only its time matters here
  await core.lock();
  await reopen(core);
  assert.equal(core.session?.lastWriteMs, ahead);
  await setSetting(core, 'wakePlan', 401);
  assert.ok(((await db.changes.orderBy('at').last())?.at ?? 0) > ahead);
});

test('a restore between the lock and the cursor write wins: the cursor is not moved', async () => {
  const { core, db, m } = await intoFebruary();
  const files = { ...m.files, write: async (path: string, bytes: Uint8Array) => {
    if (path === 'tmp/month.dclog') await db.device.put({ key: LOG_ARCHIVE, value: 'reset:CANARY-TEST' });
    return m.files.write(path, bytes);
  } };
  assert.equal(await close(core, files), 'written');
  assert.equal(await cursorOf(db), 'reset:CANARY-TEST');
});

test('a quiet write (usage lines only) is no change: the lock writes no backup', async () => {
  const { core, db } = await filledRecord();
  const m = memoryFiles();
  await close(core, m.files);
  await reopen(core);
  const before = core.session?.lastWriteMs;
  const result = await core.write({
    tables: ['changes'],
    quiet: true,
    async prepare(s, stamp) {
      const id = core.newId();
      const row = { id, r: await sealLine(s.cipher, id, 'r', { v: CHANGE_LINE_VERSION, kind: 'event', changed_at: stamp.updated_at, device: stamp.updated_by, event: { kind: 'opened' } }) };
      return { puts: [{ table: 'changes', row }], apply: () => {}, value: undefined };
    },
  });
  assert.equal(result.kind, 'Saved');
  assert.equal(core.session?.changed, false);
  assert.equal(core.session?.lastWriteMs, before);
  assert.equal(await close(core, m.files), 'unchanged');
  assert.equal((await ids(db)).length > 0, true);
});

test('the manual export still carries every line, archived months included', async () => {
  const { core, db, m, change } = await intoFebruary();
  await close(core, m.files);
  await change();
  const made = await exportBackup(core, { appVersion: '0.1.0' });
  assert.equal(made.kind, 'Saved');
  if (made.kind === 'Saved') assert.deepEqual(await idsIn(made.value.bytes), await ids(db));
});

/** Seals a month file's lines again under another vault's name. */
async function asOtherVault(file: Uint8Array): Promise<Uint8Array> {
  const f = readFrame(file, LOG_FORMAT);
  const opened = await stubBackup().openBody(f.headerBytes, f.iv, f.ct, f.header.wrappers, PASS);
  const head = jsonBytes({ ...f.header, vault_id: 'CANARY-other-vault' });
  return frame(head, await stubBackup().sealBody(opened.body, head, f.iv));
}

test('restoring the phone\'s own copy joins its month files: every line comes back; another vault\'s and a damaged one are left out and counted; the month files go and the cursor starts over', async () => {
  const { core, db, clock, m, change } = await intoFebruary();
  await close(core, m.files);
  await change();
  await close(core, m.files);
  m.store.set(`${LOG_DIR}/2025-11.dclog`, await asOtherVault(m.store.get(`${LOG_DIR}/${JAN}`) ?? new Uint8Array()));
  m.store.set(`${LOG_DIR}/2025-12.dclog`, Uint8Array.of(1, 2, 3));
  const b = { db: freshDb() };
  const bCore = openRecord({ db: b.db, now: clock.now });
  const result = await restore(bCore, { file: m.store.get(LATEST) ?? new Uint8Array(), secret: PASS, backupCipher: guardedBackup(stubBackup()), log: { files: m.files, months: true } });
  assert.deepEqual(result, { kind: 'Restored' });
  assert.deepEqual(await ids(b.db), await ids(db));
  assert.deepEqual([...m.store.keys()].filter(p => p.startsWith(`${LOG_DIR}/`)), []);
  assert.match(String(await cursorOf(b.db)), /^reset:/);
  await openSession(bCore, guarded(stubCipher()), guardedBackup(stubBackup()));
  const s = bCore.session;
  assert.ok(s);
  const lines = await Promise.all((await b.db.changes.toArray()).map(row => openLine(s.cipher, row)));
  assert.deepEqual(lines.filter(l => l.kind === 'restore').map(l => ({ months: l.detail?.months, skipped: l.detail?.months_skipped })), [{ months: 1, skipped: 2 }]);
  // and the next lock seals the restored record's finished months again
  const n = memoryFiles();
  n.store.set(LATEST, m.store.get(LATEST) ?? new Uint8Array());
  assert.equal(await close(bCore, n.files), 'written');
  assert.ok(n.store.has(`${LOG_DIR}/${JAN}`));
});

test('a backup file restored on its own (not the phone\'s copy) reads no month files, and still clears them', async () => {
  const { core, clock, m } = await intoFebruary();
  await close(core, m.files);
  await reopen(core);
  const made = await exportBackup(core, { appVersion: '0.1.0' });
  if (made.kind !== 'Saved') throw new Error(made.kind);
  const read: string[] = [];
  const files = { ...m.files, read: (path: string) => { read.push(path); return m.files.read(path); } };
  const bCore = openRecord({ db: freshDb(), now: clock.now });
  assert.deepEqual(await restore(bCore, { file: made.value.bytes, secret: PASS, backupCipher: guardedBackup(stubBackup()), log: { files, months: false } }), { kind: 'Restored' });
  assert.deepEqual(read, []);
  assert.deepEqual([...m.store.keys()].filter(p => p.startsWith(`${LOG_DIR}/`)), []);
});

test('property: through a year of locks, clock steps both ways and failed month writes, every line is always in latest or a month file', async () => {
  const step = fc.record({ days: fc.integer({ min: -3, max: 25 }), change: fc.boolean(), fail: fc.boolean() });
  await fc.assert(fc.asyncProperty(fc.array(step, { minLength: 1, maxLength: 14 }), async steps => {
    const { core, db, clock } = await filledRecord();
    const m = memoryFiles();
    const change = changer(core);
    await close(core, m.files);
    for (const s of steps) {
      clock.advance(s.days * 86_400_000);
      if (s.change) await change();
      else await reopen(core);
      m.failOn(s.fail ? 'write tmp/month.dclog' : undefined);
      await close(core, m.files);
      m.failOn(undefined);
      const kept = new Set(await idsIn(m.store.get(LATEST)));
      for (const name of [...m.store.keys()].filter(p => p.startsWith(`${LOG_DIR}/`))) for (const id of await idsIn(m.store.get(name), LOG_FORMAT)) kept.add(id);
      for (const id of await ids(db)) assert.ok(kept.has(id), `line ${id} is in no file`);
    }
  }), { numRuns: 12 });
});

test('a month file is never taken for a backup, nor a backup for a month file', async () => {
  const { core, m } = await intoFebruary();
  await close(core, m.files);
  const damaged = (e: unknown) => e instanceof BackupError && e.reason === 'damaged';
  assert.throws(() => readFrame(m.store.get(`${LOG_DIR}/${JAN}`) ?? new Uint8Array()), damaged);
  assert.throws(() => readFrame(m.store.get(LATEST) ?? new Uint8Array(), LOG_FORMAT), damaged);
});
