import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readBackupFile, restoreWith } from '../../src/app/restoreSteps.ts';
import { exportBackup } from '../../src/record/backup/export.ts';
import { frame, readFrame } from '../../src/record/backup/format.ts';
import { SAFETY } from '../../src/record/backup/copies.ts';
import { jsonBytes } from '../../src/record/bytes.ts';
import type { RecordCore } from '../../src/record/core.ts';
import { fillRecord } from '../record/helpers.ts';
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

test('a file that is not a backup is unreadable; a newer format says so; a backup gives when it was made', async () => {
  const { file } = await filledBackup();
  assert.deepEqual(readBackupFile(new TextEncoder().encode('not a backup')), { kind: 'Unreadable' });
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
