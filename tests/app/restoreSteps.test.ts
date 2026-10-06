import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readBackupFile, restoreWith } from '../../src/app/restoreSteps.ts';
import { assemble } from '../../src/app/compose.ts';
import type { AppDeps, DevicePort } from '../../src/app/context.ts';
import { exportBackup } from '../../src/record/backup/export.ts';
import { frame, readFrame } from '../../src/record/backup/format.ts';
import { gunzip, readRaw } from '../../src/record/backup/body.ts';
import { SAFETY } from '../../src/record/backup/copies.ts';
import { RAW_FORMAT } from '../../src/record/backup/restore.ts';
import { LATEST } from '../../src/record/backup/snapshot.ts';
import { jsonBytes, parseJsonBytes } from '../../src/record/bytes.ts';
import type { RecordCore } from '../../src/record/core.ts';
import { fillRecord } from '../record/helpers.ts';
import { memoryFiles } from '../record/memoryFiles.ts';
import { fakePlugin } from '../vault/fakePlugin.ts';
import { emptyApp, testDeps } from './deps.ts';
import { PASSPHRASE, realRecord } from './realRecord.ts';

const PASS = { method: 'passphrase', text: PASSPHRASE } as const;

async function backupOf(core: RecordCore): Promise<Uint8Array> {
  const result = await exportBackup(core, { appVersion: '0.1.0' });
  if (result.kind !== 'Saved') throw new Error(result.kind);
  return result.value.bytes;
}

async function filledBackup(passphrase = PASSPHRASE) {
  const r = await realRecord(passphrase);
  await fillRecord(r.core, r.clock);
  return { ...r, file: await backupOf(r.core) };
}

/** Deps whose private files are the failure-injecting stand-in, so a replace's safety copy can be made to fail. */
function failingDeps(core: RecordCore, files: ReturnType<typeof memoryFiles>['files']): AppDeps {
  const phone = fakePlugin();
  const device: DevicePort = { plugin: phone.plugin, deviceModes: true, files, onLeave: () => () => {}, onResume: () => () => {} };
  const deps = assemble(core, device);
  deps.clock.stop();                                      // tests move no real time
  return deps;
}

test('a file that is not a backup says so; a backup with a broken header is unreadable; a newer format says so; a backup gives when it was made', async () => {
  const { file } = await filledBackup();
  for (const other of [new TextEncoder().encode('not a backup'), new Uint8Array(0), Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0)]) {
    assert.deepEqual(readBackupFile(other), { kind: 'NotBackup' });
  }
  assert.deepEqual(readBackupFile(file.slice(0, 6)), { kind: 'Unreadable' });
  assert.deepEqual(readBackupFile(Uint8Array.of(...file.slice(0, 8), ...new Uint8Array(40).fill(0x7b))), { kind: 'Unreadable' });
  const f = readFrame(file);
  assert.deepEqual(readBackupFile(frame(jsonBytes({ ...f.header, format_version: 2 }), f.ct)), { kind: 'Newer' });
  const read = readBackupFile(file);
  assert.equal(read.kind, 'File');
  assert.equal(read.kind === 'File' && read.madeAt, f.header.exported_at);
});

test('into an empty record the right passphrase restores; then no phone copy is left and the passphrase opens it', async () => {
  const { file } = await filledBackup();
  const app = emptyApp();
  app.phone.copies.set('phone-lock', 'a copy from before');
  assert.deepEqual(await restoreWith(app.deps, file, PASS, false), { kind: 'Restored' });
  assert.equal(app.phone.copies.size, 0);
  await app.deps.machine.resume();
  assert.equal((await app.deps.lock.unlock(PASS)).kind, 'Open');
});

test('a wrong passphrase says wrong, a flipped byte in the body says damaged, a newer format says newer; nothing is written', async () => {
  const { file } = await filledBackup();
  const app = emptyApp();
  assert.deepEqual(await restoreWith(app.deps, file, { method: 'passphrase', text: 'CANARY not it at all' }, false), { kind: 'Message', message: 'wrong' });
  const flipped = file.slice();
  flipped[flipped.length - 20] = (flipped[flipped.length - 20] ?? 0) ^ 1;
  assert.deepEqual(await restoreWith(app.deps, flipped, PASS, false), { kind: 'Message', message: 'damaged' });
  const f = readFrame(file);
  assert.deepEqual(await restoreWith(app.deps, frame(jsonBytes({ ...f.header, format_version: 2 }), f.ct), PASS, false), { kind: 'Message', message: 'newer' });
  assert.equal(await app.db.vault.count(), 0);
});

test("into a record with data: its own backup asks without 'different record', another record's asks with it, and nothing is written", async () => {
  const mine = await filledBackup();
  const theirs = await filledBackup('CANARY another passphrase');
  const { deps } = testDeps(mine.core);
  const before = await mine.db.habits.toArray();
  assert.deepEqual(await restoreWith(deps, mine.file, PASS, false), { kind: 'Ask', otherRecord: false });
  assert.deepEqual(await restoreWith(deps, theirs.file, { method: 'passphrase', text: 'CANARY another passphrase' }, false), { kind: 'Ask', otherRecord: true });
  assert.deepEqual(await mine.db.habits.toArray(), before);
  assert.ok(mine.core.session, 'asking left the record open');
});

test("a different record's backup with a wrong passphrase says 'a different record', not 'wrong'; nothing is written", async () => {
  const mine = await filledBackup();
  const theirs = await filledBackup('CANARY another passphrase');
  const { deps } = testDeps(mine.core);
  const before = await mine.db.habits.toArray();
  assert.deepEqual(await restoreWith(deps, theirs.file, { method: 'passphrase', text: 'CANARY not their passphrase either' }, false), { kind: 'Message', message: 'other-record' });
  assert.deepEqual(await mine.db.habits.toArray(), before);
  assert.ok(mine.core.session, 'the failed attempt left the record open');
});

test("this record's own backup with a wrong passphrase still says 'wrong'; nothing is written", async () => {
  const mine = await filledBackup();
  const { deps } = testDeps(mine.core);
  const before = await mine.db.habits.toArray();
  assert.deepEqual(await restoreWith(deps, mine.file, { method: 'passphrase', text: 'CANARY not it at all' }, false), { kind: 'Message', message: 'wrong' });
  assert.deepEqual(await mine.db.habits.toArray(), before);
});

test('after asking, replace restores the other record and keeps a safety copy of what was here', async () => {
  const mine = await filledBackup();
  const theirs = await filledBackup('CANARY another passphrase');
  const { deps } = testDeps(mine.core);
  const secret = { method: 'passphrase', text: 'CANARY another passphrase' } as const;
  assert.deepEqual(await restoreWith(deps, theirs.file, secret, true), { kind: 'Restored' });
  assert.equal((await mine.db.vault.get('main'))?.vault_id, (await theirs.db.vault.get('main'))?.vault_id);
  assert.equal((await deps.device.files.list(SAFETY)).length, 1);
  assert.equal(deps.machine.state.kind, 'Locked');
});

// ── R1-4: a failed "Replace everything" says so, and ends at the lock rather than asking again.

const THEIRS = { method: 'passphrase', text: 'CANARY another passphrase' } as const;

test("R1-4: when the safety copy can't be saved, replace stops with words instead of nothing, and nothing is replaced", async () => {
  const mine = await filledBackup();
  const theirs = await filledBackup(THEIRS.text);
  const before = await mine.db.habits.toArray();
  const m = memoryFiles();
  m.failOn('write tmp/safety');
  const deps = failingDeps(mine.core, m.files);
  assert.deepEqual(await restoreWith(deps, theirs.file, THEIRS, true), { kind: 'Stopped', message: 'not-saved' });
  assert.deepEqual(await mine.db.habits.toArray(), before);
  assert.equal(mine.core.session, undefined);
  assert.equal(deps.machine.state.kind, 'Locked');
  assert.equal((await m.files.list(SAFETY)).length, 0);
});

test('R1-4: a full phone during the safety copy stops with "full", the lock-screen kind', async () => {
  const mine = await filledBackup();
  const theirs = await filledBackup(THEIRS.text);
  const m = memoryFiles();
  m.failOn('write tmp/safety', () => new DOMException('disk full', 'QuotaExceededError'));
  const deps = failingDeps(mine.core, m.files);
  assert.deepEqual(await restoreWith(deps, theirs.file, THEIRS, true), { kind: 'Stopped', message: 'full' });
  assert.equal(mine.core.session, undefined);
});

test('R1-4: a failure with no name of its own, after the keys went, still stops with words', async () => {
  const mine = await filledBackup();
  const theirs = await filledBackup(THEIRS.text);
  const m = memoryFiles();
  const deps = failingDeps(mine.core, m.files);
  // the replace itself throws once the safety copy is kept: the keys are already gone by then
  mine.db.habits.hook('creating', () => { throw new Error('CANARY injected'); });
  assert.deepEqual(await restoreWith(deps, theirs.file, THEIRS, true), { kind: 'Stopped', message: 'not-finished' });
  assert.equal(mine.core.session, undefined);
});

test('R1-4: a failure with no name of its own, with nothing locked, says so and leaves a try again', async () => {
  const theirs = await filledBackup(THEIRS.text);
  const app = emptyApp();
  app.deps.core.db.habits.hook('creating', () => { throw new Error('CANARY injected'); });
  assert.deepEqual(await restoreWith(app.deps, theirs.file, THEIRS, false), { kind: 'Message', message: 'not-finished' });
});

test('R1-4: once the keys are gone, a replace ends at the lock instead of asking again', async () => {
  const mine = await filledBackup();
  const theirs = await filledBackup(THEIRS.text);
  const m = memoryFiles();
  const deps = failingDeps(mine.core, m.files);
  await mine.core.lock();
  assert.deepEqual(await restoreWith(deps, theirs.file, THEIRS, true), { kind: 'Locked' });
  assert.equal((await m.files.list(SAFETY)).length, 0);
});

// ── R1-2: a record that refused to open is replaced from its lock screen, without being opened.

/** The record locked, with its lock damaged so the passphrase is refused, and the app put together around it. */
async function damagedRecord(snapshot?: Uint8Array) {
  const mine = await filledBackup();
  const m = memoryFiles();
  if (snapshot) await m.files.write(LATEST, snapshot);
  await mine.core.lock();
  await mine.db.vault.update('main', { kid: 'CANARY-damaged' });
  const deps = failingDeps(mine.core, m.files);
  await deps.machine.resume();
  assert.deepEqual(await deps.lock.unlock(PASS), { kind: 'Refused', reason: 'damaged' });
  m.log.length = 0;
  return { ...mine, m, deps };
}

/** Everything the record holds, to compare before and after. */
async function rowsIn(core: RecordCore) {
  const { db } = core;
  return { vault: await db.vault.toArray(), wrappers: await db.wrappers.toArray(), habits: await db.habits.toArray(), entries: await db.entries.toArray() };
}

/** The record's rows as stored, through JSON, as a raw copy holds them. */
async function storedRows(core: RecordCore) {
  const raw = await readRaw(core.db);
  return JSON.parse(JSON.stringify({ tables: raw.tables, wrappers: raw.wrappers })) as unknown;
}

/** The safety copies by extension: the raw copy opened back to its JSON, a snapshot as its bytes. */
async function keptCopies(m: ReturnType<typeof memoryFiles>) {
  const names = await m.files.list(SAFETY);
  const raw = names.filter(n => /^\d{13}\.dcraw$/.test(n));
  const snap = names.filter(n => /^\d{13}\.dcbak$/.test(n));
  assert.equal(raw.length + snap.length, names.length, `only raw copies and snapshots: ${names.join()}`);
  const rawBytes = raw[0] === undefined ? undefined : await m.files.read(`${SAFETY}/${raw[0]}`);
  return {
    names,
    raw: rawBytes && parseJsonBytes(await gunzip(rawBytes)) as { format: string; version: number; schema_version: number; tables: unknown; wrappers: unknown },
    rawText: rawBytes && new TextDecoder().decode(await gunzip(rawBytes)),
    snapshot: snap[0] === undefined ? undefined : await m.files.read(`${SAFETY}/${snap[0]}`),
  };
}

test('R1-2: a record that refuses to open asks first, then Replace keeps its rows as stored and its last snapshot, puts its backup in, and ends locked; the passphrase opens it', async () => {
  const snapshot = Uint8Array.of(1, 2, 3);                // stands in for the phone's last automatic copy
  const { core, file, m, deps } = await damagedRecord(snapshot);
  assert.deepEqual(await restoreWith(deps, file, PASS, false, true), { kind: 'Ask', otherRecord: false });
  assert.equal((await m.files.list(SAFETY)).length, 0, 'asking keeps nothing and replaces nothing');
  const before = await storedRows(core);
  assert.deepEqual(await restoreWith(deps, file, PASS, true, true), { kind: 'Restored' });
  const kept = await keptCopies(m);
  assert.equal(kept.names.length, 2);
  assert.deepEqual(kept.snapshot, snapshot);
  assert.equal(kept.raw?.format, RAW_FORMAT);
  assert.equal(kept.raw?.version, 1);
  assert.equal(kept.raw?.schema_version, core.db.verno);
  assert.deepEqual({ tables: kept.raw?.tables, wrappers: kept.raw?.wrappers }, before, 'every row and wrapper, unchanged');
  assert.ok(!kept.rawText?.includes('CANARY-TEST'), 'locked values stay locked in the raw copy');
  assert.deepEqual(await m.files.read(LATEST), file, 'the restored file is the latest copy now');
  assert.equal(core.session, undefined, 'never opened without a secret');
  assert.equal(deps.machine.state.kind, 'Locked');
  assert.equal((await deps.lock.unlock(PASS)).kind, 'Open');
});

test('R1-2: with no snapshot on the phone the rows as stored are still kept before the record is replaced', async () => {
  const { core, file, m, deps } = await damagedRecord();
  const before = await storedRows(core);
  assert.deepEqual(await restoreWith(deps, file, PASS, true, true), { kind: 'Restored' });
  const kept = await keptCopies(m);
  assert.equal(kept.names.length, 1);
  assert.equal(kept.snapshot, undefined);
  assert.deepEqual({ tables: kept.raw?.tables, wrappers: kept.raw?.wrappers }, before);
  assert.equal((await deps.lock.unlock(PASS)).kind, 'Open');
});

test("R1-2: a wrong passphrase replaces nothing and asks nothing", async () => {
  const { core, file, deps } = await damagedRecord();
  const before = await rowsIn(core);
  assert.deepEqual(await restoreWith(deps, file, { method: 'passphrase', text: 'CANARY not it at all' }, true, true), { kind: 'Message', message: 'wrong' });
  assert.deepEqual(await rowsIn(core), before);
});

test("R1-2: when the raw copy or the snapshot can't be kept, the record is exactly as it was and 'Not replaced' says so; a full phone says full", async () => {
  const cases = [
    ['write tmp/safety.dcraw', undefined, 'not-replaced'],
    ['write tmp/safety.dcraw', () => new DOMException('disk full', 'QuotaExceededError'), 'full'],
    ['write tmp/safety.dcbak', undefined, 'not-replaced'],
    ['write tmp/safety.dcbak', () => new DOMException('disk full', 'QuotaExceededError'), 'full'],
  ] as const;
  for (const [call, error, message] of cases) {
    const { core, file, m, deps } = await damagedRecord(Uint8Array.of(1, 2, 3));
    const before = await rowsIn(core);
    m.failOn(call, error);
    assert.deepEqual(await restoreWith(deps, file, PASS, true, true), { kind: 'Message', message }, call);
    assert.deepEqual(await rowsIn(core), before);
    assert.ok(!m.log.some(c => c.startsWith('write tmp/safety.dcbak')) || call.endsWith('dcbak'), 'a failed raw copy goes no further');
    assert.deepEqual(await deps.lock.unlock(PASS), { kind: 'Refused', reason: 'damaged' }, 'still the record that was here');
    m.failOn(undefined);
    assert.deepEqual(await restoreWith(deps, file, PASS, true, true), { kind: 'Restored' }, 'and it can be tried again');
  }
});

test("R1-2: when the replace itself fails, the record is exactly as it was and 'Not replaced' says so", async () => {
  const { core, db, file, deps } = await damagedRecord();
  const before = await rowsIn(core);
  db.habits.hook('creating', () => { throw new Error('CANARY injected'); });
  assert.deepEqual(await restoreWith(deps, file, PASS, true, true), { kind: 'Message', message: 'not-replaced' });
  assert.deepEqual(await rowsIn(core), before);
  assert.equal(core.session, undefined);
});

test('R1-2: without being told the record refused to open, a locked record is never replaced', async () => {
  const { core, file, m, deps } = await damagedRecord(Uint8Array.of(1, 2, 3));
  const before = await rowsIn(core);
  assert.deepEqual(await restoreWith(deps, file, PASS, true), { kind: 'Locked' });
  assert.deepEqual(await rowsIn(core), before);
  assert.equal((await m.files.list(SAFETY)).length, 0);
});
