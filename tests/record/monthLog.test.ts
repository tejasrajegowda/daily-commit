import { test } from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';
import { BackupError, type Secret } from '../../src/vault/cipher.ts';
import { openRecord, type RecordCore } from '../../src/record/core.ts';
import type { RecordDb } from '../../src/record/db.ts';
import type { ChangeRow } from '../../src/record/rows.ts';
import { CHANGE_LINE_VERSION, openLine, sealLine } from '../../src/record/changes.ts';
import { closeSession, openSession } from '../../src/record/ops/session.ts';
import { setSetting } from '../../src/record/ops/settings.ts';
import { gunzip, parseBody } from '../../src/record/backup/body.ts';
import { REPLACED } from '../../src/record/backup/copies.ts';
import { exportBackup } from '../../src/record/backup/export.ts';
import { FORMAT, LOG_FORMAT, readFrame, type BackupHeader } from '../../src/record/backup/format.ts';
import { LOG_ARCHIVE, LOG_DIR, MONTHS_A_LOCK, digestOf, parseCursor, parseMonth } from '../../src/record/backup/monthLog.ts';
import { restore } from '../../src/record/backup/restore.ts';
import { LATEST } from '../../src/record/backup/snapshot.ts';
import { filledRecord, freshDb } from './helpers.ts';
import { memoryFiles } from './memoryFiles.ts';
import { STUB_SECRETS, stubBackup } from './stubBackup.ts';
import { stubCipher } from './stubCipher.ts';
import { guarded, guardedBackup } from './txGuard.ts';
import type { testClock } from './fixtures.ts';

// The automatic copy carries the change-log lines not yet in a month file; each finished app month is
// sealed into its own file, named with its digest in the copy's header. The rule the tests attack: a
// restore of the phone's copy (latest plus the month files it names) brings back every line the
// newest written copy held, whatever failed in between.

const PASS: Secret = { method: 'passphrase', text: STUB_SECRETS.passphrase };
const never = () => new Promise<void>(() => {});
const reopen = (core: RecordCore) => openSession(core, guarded(stubCipher()), guardedBackup(stubBackup()));
type Files = ReturnType<typeof memoryFiles>;
const close = (core: RecordCore, m: Files, sleep: (ms: number) => Promise<void> = never) => closeSession(core, { files: m.files, sleep, appVersion: '0.1.0' });
const JAN = `${LOG_DIR}/2026-01.dclog`, FEB = `${LOG_DIR}/2026-02.dclog`;
const FEB_STARTS = Date.UTC(2026, 1, 1, 4);                 // the fixtures' day starts at 04:00 UTC
const MAR_STARTS = Date.UTC(2026, 2, 1, 4);

/** The ids of the lines a backup or a month file holds, opened with the stand-in. */
async function idsIn(file: Uint8Array | undefined, format: BackupHeader['format'] = FORMAT): Promise<string[]> {
  if (!file) throw new Error('no such file');
  const f = readFrame(file, format);
  const opened = await stubBackup().openBody(f.headerBytes, f.iv, f.ct, f.header.wrappers, PASS);
  const body = await gunzip(opened.body);
  const rows = format === LOG_FORMAT ? parseMonth(body) : (parseBody(body, f.header.schema_version).changes as readonly ChangeRow[]);
  return rows.map(r => r.id).sort();
}
/** Every line a restore of the phone's copy could bring back: latest's, and those of each month file it names that is there unchanged. */
async function recoverable(m: Files): Promise<Set<string>> {
  const latest = m.store.get(LATEST);
  const out = new Set(await idsIn(latest));
  for (const f of readFrame(latest ?? new Uint8Array()).header.log_files ?? []) {
    const bytes = m.store.get(`${LOG_DIR}/${f.name}`);
    if (bytes && (await digestOf(bytes)) === f.sha256) for (const id of await idsIn(bytes, LOG_FORMAT)) out.add(id);
  }
  return out;
}
const ids = async (db: RecordDb, keep: (line: ChangeRow) => boolean = () => true) => (await db.changes.toArray()).filter(keep).map(r => r.id).sort();
const cursorOf = async (db: RecordDb) => parseCursor((await db.device.get(LOG_ARCHIVE))?.value);
const monthFiles = (m: Files) => [...m.store.keys()].filter(p => p.startsWith(`${LOG_DIR}/`)).sort();

/** Each call opens the record and changes one setting, so the next lock seals a snapshot. */
function changer(core: RecordCore) {
  let n = 400;
  return async () => {
    await reopen(core);
    const saved = await setSetting(core, 'wakePlan', n++);
    if (saved.kind !== 'Saved') throw new Error(saved.kind);
  };
}

/** A January record locked once, then a change in February, not yet locked. */
async function intoFebruary() {
  const t = await filledRecord();                           // its clock ends 2026-01-06 20:00
  const m = memoryFiles();
  const change = changer(t.core);
  assert.equal(await close(t.core, m), 'written');
  const january = await ids(t.db);
  t.clock.set('2026-02-02T10:00:00Z');
  await change();
  return { ...t, m, change, january };
}

test('the first snapshot of a new app month seals January into its own file, and latest then holds only February\'s lines and names the file with its digest', async () => {
  const { core, db, clock, m, change, january } = await intoFebruary();
  clock.advance(3_600_000);                                 // the lock comes later than the change, so a cursor at "now" would be caught
  assert.equal(await close(core, m), 'written');
  assert.deepEqual(await idsIn(m.store.get(JAN), LOG_FORMAT), january);
  const feb = await ids(db, l => (l.at ?? 0) >= FEB_STARTS);
  assert.ok(feb.length > 0);
  assert.deepEqual(await idsIn(m.store.get(LATEST)), feb);
  assert.deepEqual(readFrame(m.store.get(LATEST) ?? new Uint8Array()).header.log_files, [{ name: '2026-01.dclog', sha256: await digestOf(m.store.get(JAN) ?? new Uint8Array()) }]);
  assert.deepEqual([...await recoverable(m)].sort(), await ids(db));
  await change();
  m.log.length = 0;
  assert.equal(await close(core, m), 'written');
  assert.deepEqual(m.log.filter(c => c.includes('.dclog') && !c.startsWith('list')), [], 'a month file is written once');
});

test('a month file that fails to write keeps the last latest (it still holds those lines) and the cursor; the next lock writes both', async () => {
  const { core, db, m, change, january } = await intoFebruary();
  const before = m.store.get(LATEST);
  m.failOn('rename tmp/month.dclog');
  assert.equal(await close(core, m), 'failed');
  assert.deepEqual(m.store.get(LATEST), before);
  assert.equal(m.store.has(JAN), false);
  assert.deepEqual(await cursorOf(db), { gen: '', before: null, ranges: [] });
  m.failOn(undefined);
  await change();
  assert.equal(await close(core, m), 'written');
  assert.deepEqual(await idsIn(m.store.get(JAN), LOG_FORMAT), january);
  assert.deepEqual([...await recoverable(m)].sort(), await ids(db));
});

test('a listed month file that has gone is made again from the database at the next lock, with the same lines', async () => {
  const { core, db, m, change, january } = await intoFebruary();
  await close(core, m);
  m.store.delete(JAN);
  await change();
  assert.equal(await close(core, m), 'written');
  assert.deepEqual(await idsIn(m.store.get(JAN), LOG_FORMAT), january);
  assert.deepEqual([...await recoverable(m)].sort(), await ids(db));
});

test('a clock set back into the archived month: a new change\'s line is stamped after the cursor, so the next latest holds it', async () => {
  const { core, db, clock, m, change } = await intoFebruary();
  await close(core, m);
  clock.set('2026-01-20T10:00:00Z');
  await change();
  const newest = (await db.changes.orderBy('at').last())?.id;
  assert.equal(await close(core, m), 'written');
  assert.ok(newest && (await idsIn(m.store.get(LATEST))).includes(newest));
});

test('a line newer than every row (a restore\'s or baseline\'s) still sets the floor: the next stamp comes after it', async () => {
  const { core, db, clock } = await filledRecord();
  const ahead = clock.now() + 30 * 86_400_000;
  await db.changes.add({ id: 'CANARY-line', at: ahead });   // only its time matters here
  await core.lock();
  await reopen(core);
  assert.equal(core.session?.lastWriteMs, ahead);
  await setSetting(core, 'wakePlan', 401);
  assert.ok(((await db.changes.orderBy('at').last())?.at ?? 0) > ahead);
});

test('a restore that lands between the lock and its writes wins: that lock writes no file and moves nothing', async () => {
  const { core, db, m } = await intoFebruary();
  const latest = m.store.get(LATEST);
  let once = false;
  const files = { ...m.files, list: async (dir: string) => {
    // the first listing happens while sealing, after the cursor row was read: a restore's new row lands here
    if (!once) { once = true; await db.device.put({ key: LOG_ARCHIVE, value: '{"gen":"CANARY-restore","before":null,"ranges":[]}' }); }
    return m.files.list(dir);
  } };
  assert.equal(await closeSession(core, { files, sleep: never, appVersion: '0.1.0' }), 'unchanged');
  assert.equal((await cursorOf(db)).gen, 'CANARY-restore');
  assert.deepEqual(monthFiles(m), []);
  assert.deepEqual(m.store.get(LATEST), latest);
});

test('a lock that runs out of time still writes the month files it finished, and moves the cursor past them', async () => {
  const { core, db, clock, m, change } = await intoFebruary();
  await core.lock();
  clock.set('2026-06-02T10:00:00Z');                         // January and February to file, then the snapshot
  let sealing = 0;
  const slow = { ...stubBackup(), sealBody: (body: Uint8Array, header: Uint8Array, iv: Uint8Array) => (++sealing <= 2 ? stubBackup().sealBody(body, header, iv) : new Promise<Uint8Array>(() => {})) };
  await openSession(core, guarded(stubCipher()), guardedBackup(slow));
  await setSetting(core, 'wakePlan', 500);
  let release: () => void = () => {};
  const gate = new Promise<void>(r => { release = r; });
  const sleep = () => gate;
  const closing = close(core, m, sleep);
  while (sealing < 3) await new Promise(r => setTimeout(r, 5));
  release();
  assert.equal(await closing, 'abandoned');
  assert.equal(monthFiles(m).length, 2);
  assert.equal((await cursorOf(db)).ranges.length, 2);
  await change();
  assert.equal(await close(core, m), 'written');
  assert.deepEqual([...await recoverable(m)].sort(), await ids(db));
});

test(`at most ${MONTHS_A_LOCK} month files a lock: a backlog is filed over several locks, each of them written`, async () => {
  const { core, db, clock, m, change } = await intoFebruary();
  clock.set('2026-03-02T10:00:00Z'); await change();
  clock.set('2026-04-02T10:00:00Z'); await change();
  clock.set('2026-05-02T10:00:00Z'); await change();
  clock.set('2026-06-02T10:00:00Z'); await change();
  assert.equal(await close(core, m), 'written');
  assert.equal(monthFiles(m).length, MONTHS_A_LOCK);
  await change();
  assert.equal(await close(core, m), 'written');
  assert.deepEqual(monthFiles(m), ['2026-01', '2026-02', '2026-03', '2026-04', '2026-05'].map(n => `${LOG_DIR}/${n}.dclog`));
  assert.deepEqual([...await recoverable(m)].sort(), await ids(db));
});

test('a folder that can\'t be listed: latest carries every line and no month work is done', async () => {
  const { core, db, m } = await intoFebruary();
  m.failOn('list backup/log');
  assert.equal(await close(core, m), 'written');
  m.failOn(undefined);
  assert.deepEqual(await idsIn(m.store.get(LATEST)), await ids(db));
  assert.deepEqual(monthFiles(m), []);
});

test('a stray month file the cursor doesn\'t list is moved to log-replaced/, never deleted, and never stops a name being used', async () => {
  const { core, m } = await intoFebruary();
  m.store.set(JAN, Uint8Array.of(9, 9, 9));
  assert.equal(await close(core, m), 'written');
  assert.deepEqual(monthFiles(m), [`${LOG_DIR}/2026-01.2.dclog`]);
  const moved = [...m.store.keys()].filter(k => k.startsWith(`${REPLACED}/`));
  assert.equal(moved.length, 1);
  assert.match(moved[0] ?? '', /^log-replaced\/\d{13}\.2026-01\.dclog$/);
  assert.deepEqual([...m.store.get(moved[0] ?? '') ?? []], [9, 9, 9]);
});

test('a quiet write (usage lines only) is no change: the lock writes no backup; a quiet write that touches the record is refused', async () => {
  const { core, m } = await intoFebruary();
  await close(core, m);
  await reopen(core);
  const before = core.session?.lastWriteMs;
  const line = (s: NonNullable<RecordCore['session']>, at: number, device: string) => {
    const id = core.newId();
    return sealLine(s.cipher, id, 'r', { v: CHANGE_LINE_VERSION, kind: 'event', changed_at: at, device, event: { kind: 'opened' } }).then(r => ({ id, r }));
  };
  const result = await core.write({
    tables: ['changes'], quiet: true,
    async prepare(s, stamp) { return { puts: [{ table: 'changes', row: await line(s, stamp.updated_at, stamp.updated_by) }], apply: () => {}, value: undefined }; },
  });
  assert.equal(result.kind, 'Saved');
  assert.equal(core.session?.changed, false);
  assert.equal(core.session?.lastWriteMs, before);
  await assert.rejects(core.write({
    tables: ['changes', 'device'], quiet: true,
    async prepare(s, stamp) { return { puts: [{ table: 'changes', row: await line(s, stamp.updated_at, stamp.updated_by) }, { table: 'device', row: { key: 'CANARY', value: 1 } }], apply: () => {}, value: undefined }; },
  }), /quiet write/);
  assert.equal(await close(core, m), 'unchanged');
});

test('the manual export still carries every line, archived months included', async () => {
  const { core, db, m, change } = await intoFebruary();
  await close(core, m);
  await change();
  const made = await exportBackup(core, { appVersion: '0.1.0' });
  assert.equal(made.kind, 'Saved');
  if (made.kind === 'Saved') {
    assert.deepEqual(await idsIn(made.value.bytes), await ids(db));
    assert.equal(readFrame(made.value.bytes).header.log_files, undefined);
  }
});

/** A record with January and February filed, locked in March. */
async function intoMarch() {
  const t = await intoFebruary();
  await close(t.core, t.m);
  t.clock.set('2026-03-03T10:00:00Z');
  await t.change();
  assert.equal(await close(t.core, t.m), 'written');
  return t;
}

async function restoreLines(db: RecordDb, core: RecordCore) {
  await openSession(core, guarded(stubCipher()), guardedBackup(stubBackup()));
  const s = core.session;
  assert.ok(s);
  return Promise.all((await db.changes.toArray()).map(row => openLine(s.cipher, row)));
}

test('restoring the phone\'s own copy joins the month files it names, keeps them, and carries on from them; a changed one and a stray are left out, moved aside, and counted', async () => {
  const { db, clock, m } = await intoMarch();
  const all = await ids(db);
  m.store.set(`${LOG_DIR}/2025-12.dclog`, Uint8Array.of(1, 2, 3));            // a stray the copy doesn't name
  const b = freshDb();
  const bCore = openRecord({ db: b, now: clock.now });
  assert.deepEqual(await restore(bCore, { file: m.store.get(LATEST) ?? new Uint8Array(), secret: PASS, backupCipher: guardedBackup(stubBackup()), log: { files: m.files, months: true } }), { kind: 'Restored' });
  assert.deepEqual(await ids(b), all);
  assert.deepEqual(monthFiles(m), [JAN, FEB]);                                   // kept, not cleared
  assert.equal([...m.store.keys()].filter(k => k.startsWith(`${REPLACED}/`)).length, 1);
  const cursor = await cursorOf(b);
  assert.deepEqual(cursor.ranges.map(r => r.name), ['2026-01.dclog', '2026-02.dclog']);
  assert.ok(cursor.before !== null && cursor.before >= MAR_STARTS - 86_400_000);
  const lines = await restoreLines(b, bCore);
  assert.deepEqual(lines.filter(l => l.kind === 'restore').map(l => [l.detail?.months, l.detail?.months_missing]), [[2, 0]]);
  // the next lock carries on: no month filed again, latest small
  m.log.length = 0;
  assert.equal(await close(bCore, m), 'written');
  assert.deepEqual(m.log.filter(c => c.includes('.dclog') && !c.startsWith('list')), []);
  assert.deepEqual([...await recoverable(m)].sort(), await ids(b));
});

test('a month file changed on the phone fails its digest: it is not joined, counted missing, and moved aside', async () => {
  const { clock, m } = await intoMarch();
  const feb = m.store.get(FEB) ?? new Uint8Array();
  m.store.set(FEB, Uint8Array.from(feb, (x, i) => (i === feb.length - 1 ? x ^ 1 : x)));
  const b = freshDb();
  const bCore = openRecord({ db: b, now: clock.now });
  assert.deepEqual(await restore(bCore, { file: m.store.get(LATEST) ?? new Uint8Array(), secret: PASS, backupCipher: guardedBackup(stubBackup()), log: { files: m.files, months: true } }), { kind: 'Restored' });
  assert.deepEqual(monthFiles(m), [JAN]);
  const lines = await restoreLines(b, bCore);
  assert.deepEqual(lines.filter(l => l.kind === 'restore').map(l => [l.detail?.months, l.detail?.months_missing]), [[1, 1]]);
});

test('restoring any other file moves every month file aside (never deleted), starts the cursor over, and the next lock files the restored record\'s months again', async () => {
  const { core, clock, m } = await intoMarch();
  await reopen(core);
  const made = await exportBackup(core, { appVersion: '0.1.0' });
  if (made.kind !== 'Saved') throw new Error(made.kind);
  const b = freshDb();
  const bCore = openRecord({ db: b, now: clock.now });
  assert.deepEqual(await restore(bCore, { file: made.value.bytes, secret: PASS, backupCipher: guardedBackup(stubBackup()), log: { files: m.files, months: false } }), { kind: 'Restored' });
  assert.deepEqual(monthFiles(m), []);
  assert.equal([...m.store.keys()].filter(k => k.startsWith(`${REPLACED}/`)).length, 2);
  assert.deepEqual((await cursorOf(b)).ranges, []);
  await restoreLines(b, bCore);
  assert.equal(await close(bCore, m), 'written');
  assert.deepEqual(monthFiles(m), [JAN, FEB]);
  assert.deepEqual([...await recoverable(m)].sort(), await ids(b));
});

test('a month file is never taken for a backup, nor a backup for a month file', async () => {
  const { core, m } = await intoFebruary();
  await close(core, m);
  const damaged = (e: unknown) => e instanceof BackupError && e.reason === 'damaged';
  assert.throws(() => readFrame(m.store.get(JAN) ?? new Uint8Array()), damaged);
  assert.throws(() => readFrame(m.store.get(LATEST) ?? new Uint8Array(), LOG_FORMAT), damaged);
  assert.equal(readFrame(m.store.get(JAN) ?? new Uint8Array(), LOG_FORMAT).header.exported_at, 0);   // no time in a month file's plain header
});

const FAILS = ['', 'write tmp/month.dclog', 'rename tmp/month.dclog', 'write tmp/snapshot.dcbak', 'rename tmp/snapshot.dcbak'] as const;

test('property: over a year of locks, with clock steps both ways, a changed day boundary, any file write failing, locks out of time and restores of the phone\'s copy, that copy always brings back every line of the newest copy written', async () => {
  const step = fc.record({
    days: fc.integer({ min: -3, max: 40 }), change: fc.boolean(), fail: fc.constantFrom(...FAILS), late: fc.boolean(),
    restore: fc.integer({ min: 0, max: 9 }), boundary: fc.integer({ min: 0, max: 14 }),
  });
  await fc.assert(fc.asyncProperty(fc.array(step, { minLength: 8, maxLength: 20 }), async steps => {
    const t = await filledRecord();
    const m = memoryFiles();
    let core = t.core;
    let change = changer(core);
    const clock: ReturnType<typeof testClock> = t.clock;
    assert.equal(await close(core, m), 'written');
    let held = new Set(await ids(t.db));                    // the lines of the newest copy written
    let db = t.db;
    for (const s of steps) {
      clock.advance(s.days * 86_400_000);
      if (s.change) await change();
      else await reopen(core);
      if (s.boundary === 0) await setSetting(core, 'boundary', 180 + (clock.now() % 120));
      m.failOn(s.fail === '' ? undefined : s.fail);
      const outcome = await close(core, m, s.late ? async () => {} : never);
      m.failOn(undefined);
      if (outcome === 'written') held = new Set(await ids(db));
      const back = await recoverable(m);
      for (const id of held) assert.ok(back.has(id), `line ${id} of the newest copy can't be restored`);
      if (s.restore === 0) {
        const b = freshDb();
        const bCore = openRecord({ db: b, now: clock.now });
        const result = await restore(bCore, { file: m.store.get(LATEST) ?? new Uint8Array(), secret: PASS, backupCipher: guardedBackup(stubBackup()), log: { files: m.files, months: true } });
        assert.deepEqual(result, { kind: 'Restored' });
        const restored = new Set(await ids(b));
        for (const id of held) assert.ok(restored.has(id), `line ${id} didn't come back`);
        await reopen(bCore);
        await bCore.lock();
        core = bCore;
        db = b;
        change = changer(core);
        held = restored;
      }
    }
  }), { numRuns: 10 });
});
