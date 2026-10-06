import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { lockMachine } from '../../src/app/lockMachine.ts';
import { restoreBackup } from '../../src/app/restoreFlow.ts';
import { openRecord, type RecordCore } from '../../src/record/core.ts';
import type { RecordDb } from '../../src/record/db.ts';
import { BODY_TABLES } from '../../src/record/backup/body.ts';
import { exportBackup } from '../../src/record/backup/export.ts';
import { frame, headerBytes, readFrame } from '../../src/record/backup/format.ts';
import { restore } from '../../src/record/backup/restore.ts';
import { openSession } from '../../src/record/ops/session.ts';
import { replaceWrapper } from '../../src/record/ops/vault.ts';
import { backupCipher } from '../../src/vault/backupCipher.ts';
import type { Secret } from '../../src/vault/cipher.ts';
import { enrolMode } from '../../src/vault/devices.ts';
import type { VaultPlugin } from '../../src/vault/plugin.ts';
import { systemRandom } from '../../src/vault/random.ts';
import { changePassphrase, sessionCiphers, unlockWithSecret } from '../../src/vault/vault.ts';
import { fillRecord, freshDb } from '../record/helpers.ts';
import { testClock } from '../record/fixtures.ts';
import { memoryFiles } from '../record/memoryFiles.ts';
import { guarded, guardedBackup } from '../record/txGuard.ts';
import { fakePlugin } from '../vault/fakePlugin.ts';
import { GOLDEN_CODE, GOLDEN_PASSPHRASE } from '../vault/vectors.ts';
import { PASSPHRASE, realRecord, rowsOf } from './realRecord.ts';

const PASS: Secret = { method: 'passphrase', text: PASSPHRASE };
const OPTS = { appVersion: '0.1.0', iv: new Uint8Array(12).fill(7) };
const never = () => new Promise<void>(() => {});
const sessionOf = (core: RecordCore) => core.session;
const rowsIn = async (db: RecordDb) => Object.fromEntries(await Promise.all(BODY_TABLES.map(async t => [t, await db.table(t).toArray()] as const)));
const isEmpty = async (db: RecordDb) => (await Promise.all(db.tables.map(t => t.count()))).every(n => n === 0);

/** A real record holding one of each kind of row (the same invented rows as the record tests'). */
async function filledReal(passphrase = PASSPHRASE) {
  const r = await realRecord(passphrase);
  await fillRecord(r.core, r.clock);
  return r;
}

async function exportOf(core: RecordCore): Promise<Uint8Array> {
  const result = await exportBackup(core, OPTS);
  if (result.kind !== 'Saved') throw new Error(result.kind);
  return result.value.bytes;
}

function emptyRecord(now = testClock('2026-01-06T20:00:00Z').now) {
  const db = freshDb();
  return { db, core: openRecord({ db, now }) };
}

/** Opens a record with what was typed, as the app does: the vault's rows, then the session. */
async function unlock(core: RecordCore, secret: Secret): Promise<string> {
  const opened = await unlockWithSecret(await rowsOf(core), secret);
  if (opened.kind !== 'Unlocked') return opened.kind;
  const { cipher, backup } = sessionCiphers(opened.keys);
  await openSession(core, guarded(cipher), guardedBackup(backup));
  return opened.kind;
}

test('round trip with the real cipher: every row and envelope, the vault, and the same record opened by the passphrase and, separately, by the recovery code', async () => {
  const a = await filledReal();
  const file = await exportOf(a.core);
  const b = emptyRecord();
  assert.deepEqual(await restore(b.core, { file, secret: PASS, backupCipher: guardedBackup(backupCipher()) }), { kind: 'Restored' });
  assert.deepEqual(await rowsIn(b.db), await rowsIn(a.db));                                // senses 1 and 2
  assert.deepEqual(await b.db.wrappers.toArray(), await a.db.wrappers.toArray());           // sense 3
  assert.equal(await unlock(b.core, PASS), 'Unlocked');                                      // sense 4, the passphrase
  assert.deepEqual(sessionOf(b.core)?.model, sessionOf(a.core)?.model);                      // senses 4 and 5: the whole record
  await b.core.lock();
  assert.equal(await unlock(b.core, { method: 'recovery', text: a.code }), 'Unlocked');     // sense 4, the recovery code
  assert.deepEqual(sessionOf(b.core)?.model, sessionOf(a.core)?.model);
});

test('export, restore, export again with the real cipher: the same bytes, with the time and the IV fixed', async () => {
  const a = await filledReal();
  const first = await exportOf(a.core);
  const b = emptyRecord(a.clock.now);
  await restore(b.core, { file: first, secret: PASS, backupCipher: backupCipher() });
  await unlock(b.core, PASS);
  assert.deepEqual(await exportOf(b.core), first);                                           // sense 6
});

test('the real v1 fixture still opens: by the golden passphrase and by the golden code, every table, and the record unlocks', async () => {
  const file = new Uint8Array(readFileSync(join(import.meta.dirname, '..', 'record', 'fixtures', 'backup-v1-real.fixture.bin')));
  const f = readFrame(file);
  assert.deepEqual(frame(f.headerBytes, f.ct), file);
  assert.deepEqual([f.header.format_version, f.header.schema_version, f.header.generation], [1, 1, 1]);
  const byPass = await backupCipher().openBody(f.headerBytes, f.iv, f.ct, f.header.wrappers, { method: 'passphrase', text: GOLDEN_PASSPHRASE });
  const byCode = await backupCipher().openBody(f.headerBytes, f.iv, f.ct, f.header.wrappers, { method: 'recovery', text: GOLDEN_CODE });
  assert.deepEqual(byPass.body, byCode.body);
  const b = emptyRecord();
  assert.deepEqual(await restore(b.core, { file, secret: { method: 'recovery', text: GOLDEN_CODE }, backupCipher: backupCipher() }), { kind: 'Restored' });
  assert.deepEqual(
    Object.fromEntries(await Promise.all(BODY_TABLES.map(async t => [t, await b.db.table(t).count()] as const))),
    { vault: 1, settings: 6, habits: 1, observations: 2, days: 0, entries: 1, notyet: 1, cues: 1, reviews: 1 },
  );
  assert.equal(await unlock(b.core, { method: 'passphrase', text: GOLDEN_PASSPHRASE }), 'Unlocked');
  assert.deepEqual([...(sessionOf(b.core)?.model.entries.values() ?? [])].map(e => e.body), ['CANARY-TEST page']);
});

test('generations: an older copy opens with the passphrase it was made under, never the new one; the recovery code opens both', async () => {
  const a = await filledReal();
  const older = await exportOf(a.core);
  const made = await changePassphrase(await rowsOf(a.core), PASS, 'CANARY new', systemRandom, a.clock.now());
  if (made.kind !== 'Done') throw new Error(made.kind);
  assert.equal((await replaceWrapper(a.core, made.value)).kind, 'Saved');
  const newer = await exportOf(a.core);
  assert.equal(readFrame(newer).header.generation, 2);
  const tryRestore = async (file: Uint8Array, secret: Secret) => {
    const b = emptyRecord();
    const result = await restore(b.core, { file, secret, backupCipher: backupCipher() });
    if (result.kind !== 'Restored') assert.ok(await isEmpty(b.db));
    return result;
  };
  assert.deepEqual(await tryRestore(older, PASS), { kind: 'Restored' });
  assert.deepEqual(await tryRestore(older, { method: 'passphrase', text: 'CANARY new' }), { kind: 'Refused', reason: 'wrong-secret' });
  assert.deepEqual(await tryRestore(newer, { method: 'passphrase', text: 'CANARY new' }), { kind: 'Restored' });
  assert.deepEqual(await tryRestore(newer, PASS), { kind: 'Refused', reason: 'wrong-secret' });
  for (const file of [older, newer]) assert.deepEqual(await tryRestore(file, { method: 'recovery', text: a.code }), { kind: 'Restored' });
});

test('an edited header is told apart and writes nothing: a changed generation is damaged; a passphrase copy naming another key reads as a wrong passphrase, and the recovery code then says damaged', async () => {
  const a = await filledReal();
  const file = await exportOf(a.core);
  const f = readFrame(file);
  const edited = (change: (h: typeof f.header) => typeof f.header) => frame(headerBytes(change(f.header)), f.ct);
  const tryRestore = async (bytes: Uint8Array, secret: Secret) => {
    const b = emptyRecord();
    const result = await restore(b.core, { file: bytes, secret, backupCipher: backupCipher() });
    assert.ok(await isEmpty(b.db));
    return result;
  };
  const generation = edited(h => ({ ...h, generation: 9 }));
  assert.deepEqual(await tryRestore(generation, PASS), { kind: 'Refused', reason: 'damaged' });
  assert.deepEqual(await tryRestore(generation, { method: 'recovery', text: a.code }), { kind: 'Refused', reason: 'damaged' });
  const kid = edited(h => ({ ...h, wrappers: { ...h.wrappers, passphrase: { ...h.wrappers.passphrase, kid: h.vault_id } } }));
  assert.deepEqual(await tryRestore(kid, PASS), { kind: 'Refused', reason: 'wrong-secret' });
  assert.deepEqual(await tryRestore(kid, { method: 'recovery', text: a.code }), { kind: 'Refused', reason: 'damaged' });
});

test('restore through the app forgets every phone copy; the restored file then opens with its own passphrase', async () => {
  const a = await filledReal();
  const file = await exportOf(a.core);
  const c = await realRecord('CANARY other passphrase');
  const f = fakePlugin();
  const other: Secret = { method: 'passphrase', text: 'CANARY other passphrase' };
  await enrolMode(await rowsOf(c.core), other, f.plugin, 'own-code', '24681357');
  await enrolMode(await rowsOf(c.core), other, f.plugin, 'fingerprint');
  const m = memoryFiles();
  const machine = lockMachine({ core: c.core, plugin: f.plugin, close: { files: m.files, sleep: never, appVersion: '0.1.0' } });
  const result = await restoreBackup({ core: c.core, plugin: f.plugin, machine }, { file, secret: PASS, backupCipher: backupCipher(), replace: { files: m.files, appVersion: '0.1.0' } });
  assert.deepEqual(result, { kind: 'Restored' });
  assert.equal(f.copies.size, 0);
  assert.deepEqual(machine.state, { kind: 'Locked', offered: [] });                        // the passphrase is the only way in
  assert.deepEqual(await machine.unlock(other), { kind: 'WrongSecret' });
  assert.deepEqual(await machine.unlock(PASS), { kind: 'Open' });
  assert.deepEqual(sessionOf(c.core)?.model, sessionOf(a.core)?.model);
});

test('a phone copy left behind when forgetting failed still never opens the restored vault: each is deleted as it is tried', async () => {
  const a = await filledReal();
  const file = await exportOf(a.core);
  const c = await realRecord('CANARY other passphrase');
  const f = fakePlugin();
  const other: Secret = { method: 'passphrase', text: 'CANARY other passphrase' };
  await enrolMode(await rowsOf(c.core), other, f.plugin, 'own-code', '24681357');
  await enrolMode(await rowsOf(c.core), other, f.plugin, 'fingerprint');
  let refusing = true;                                               // every delete fails during the restore, retry included
  const plugin = { ...f.plugin, remove: async (mode: Parameters<typeof f.plugin.remove>[0]) => {
    if (refusing) throw new Error('the phone did not answer');
    return f.plugin.remove(mode);
  } };
  const m = memoryFiles();
  const machine = lockMachine({ core: c.core, plugin, close: { files: m.files, sleep: never, appVersion: '0.1.0' } });
  assert.deepEqual(await restoreBackup({ core: c.core, plugin, machine }, { file, secret: PASS, backupCipher: backupCipher(), replace: { files: m.files, appVersion: '0.1.0' } }), { kind: 'Restored' });
  refusing = false;
  assert.deepEqual(machine.state, { kind: 'Locked', offered: ['own-code', 'fingerprint'] });   // left behind
  assert.deepEqual(await machine.unlock({ mode: 'fingerprint' }), { kind: 'CopyGone', offered: ['own-code'] });
  assert.deepEqual(await machine.unlock({ mode: 'own-code', code: '24681357' }), { kind: 'CopyGone', offered: [] });
  assert.equal(f.copies.size, 0);
  assert.equal(c.core.session, undefined);
});

// ── Review R1: a restore of this same vault, and a restore that fails halfway.

test('R1-4: a phone that refuses the first delete still loses every copy, so a copy of this same vault can\'t open the restored record', async () => {
  const { core } = await realRecord();
  const exported = await exportBackup(core, OPTS);
  if (exported.kind !== 'Saved') throw new Error(exported.kind);
  const f = fakePlugin();
  assert.equal((await enrolMode(await rowsOf(core), PASS, f.plugin, 'own-code', '24681357')).kind, 'Enrolled');
  assert.equal((await enrolMode(await rowsOf(core), PASS, f.plugin, 'fingerprint')).kind, 'Enrolled');
  let refusals = 1;
  const plugin: VaultPlugin = {
    ...f.plugin,
    remove: async mode => {
      if (refusals > 0) { refusals -= 1; throw new Error('the phone did not answer'); }
      return f.plugin.remove(mode);
    },
  };
  const m = memoryFiles();
  const machine = lockMachine({ core, plugin, close: { files: m.files, sleep: never, appVersion: '0.1.0' } });
  const result = await restoreBackup({ core, plugin, machine }, { file: exported.value.bytes, secret: PASS, backupCipher: backupCipher(), replace: { files: m.files, appVersion: '0.1.0' } });
  assert.equal(result.kind, 'Restored');
  assert.equal(f.copies.size, 0);
  assert.deepEqual(machine.state, { kind: 'Locked', offered: [] });
  assert.equal((await machine.unlock({ mode: 'fingerprint' })).kind, 'CopyGone');
  assert.equal(core.session, undefined);
});

test('R1-4: a safety copy that fails to write says so and leaves the machine locked, not saying Open; a retry finds the keys already gone', async () => {
  const { core } = await realRecord();
  const exported = await exportBackup(core, OPTS);
  if (exported.kind !== 'Saved') throw new Error(exported.kind);
  const m = memoryFiles();
  m.failOn('write tmp/safety');
  const f = fakePlugin();
  const machine = lockMachine({ core, plugin: f.plugin, close: { files: m.files, sleep: never, appVersion: '0.1.0' } });
  const input = { file: exported.value.bytes, secret: PASS, backupCipher: backupCipher(), replace: { files: m.files, appVersion: '0.1.0' } };
  assert.deepEqual(await restoreBackup({ core, plugin: f.plugin, machine }, input), { kind: 'CopyFailed' });
  assert.equal(core.session, undefined);
  assert.deepEqual(machine.state, { kind: 'Locked', offered: [] });
  m.failOn(undefined);
  // the keys never come back on their own: a retry can only ever find them already gone
  assert.deepEqual(await restoreBackup({ core, plugin: f.plugin, machine }, input), { kind: 'Locked' });
  assert.equal(core.session, undefined);
});

test('R1-4: a full phone during the safety copy says so, as "full" does elsewhere', async () => {
  const { core } = await realRecord();
  const exported = await exportBackup(core, OPTS);
  if (exported.kind !== 'Saved') throw new Error(exported.kind);
  const m = memoryFiles();
  m.failOn('write tmp/safety', () => new DOMException('disk full', 'QuotaExceededError'));
  const f = fakePlugin();
  const machine = lockMachine({ core, plugin: f.plugin, close: { files: m.files, sleep: never, appVersion: '0.1.0' } });
  const input = { file: exported.value.bytes, secret: PASS, backupCipher: backupCipher(), replace: { files: m.files, appVersion: '0.1.0' } };
  assert.deepEqual(await restoreBackup({ core, plugin: f.plugin, machine }, input), { kind: 'QuotaFull' });
  assert.equal(core.session, undefined);
  assert.deepEqual(machine.state, { kind: 'Locked', offered: [] });
});
