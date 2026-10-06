import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readBackupFile, restoreWith } from '../../src/app/restoreSteps.ts';
import { assemble } from '../../src/app/compose.ts';
import type { AppDeps, DevicePort } from '../../src/app/context.ts';
import { exportBackup } from '../../src/record/backup/export.ts';
import { frame, readFrame } from '../../src/record/backup/format.ts';
import { SAFETY } from '../../src/record/backup/copies.ts';
import { jsonBytes } from '../../src/record/bytes.ts';
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
