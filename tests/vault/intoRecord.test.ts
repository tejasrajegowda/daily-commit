import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openRecord, type RecordCore } from '../../src/record/core.ts';
import { firstRun } from '../../src/record/ops/firstRun.ts';
import { closeSession, openSession } from '../../src/record/ops/session.ts';
import { setSetting } from '../../src/record/ops/settings.ts';
import { replaceWrapper, vaultRows, type VaultRows } from '../../src/record/ops/vault.ts';
import { LATEST } from '../../src/record/backup/snapshot.ts';
import { readFrame } from '../../src/record/backup/format.ts';
import type { Secret } from '../../src/vault/cipher.ts';
import { createVault } from '../../src/vault/keys.ts';
import { systemRandom } from '../../src/vault/random.ts';
import { changePassphrase, replaceRecoveryCode, sessionCiphers, unlockWithSecret, withRawMasterKey } from '../../src/vault/vault.ts';
import { backupCipher } from '../../src/vault/backupCipher.ts';
import { freshDb } from '../record/helpers.ts';
import { memoryFiles } from '../record/memoryFiles.ts';
import { guarded, guardedBackup } from '../record/txGuard.ts';
import { SETTINGS, testClock } from '../record/fixtures.ts';

const PASSPHRASE = 'CANARY passphrase';
const PASS: Secret = { method: 'passphrase', text: PASSPHRASE };
const never = () => new Promise<void>(() => {});
/** The open session, read fresh each time (TypeScript would otherwise remember an earlier check). */
const sessionOf = (core: RecordCore) => core.session;

/** A record set up through first run with a real vault, open, plus its recovery code. */
async function realRecord() {
  const db = freshDb();
  const clock = testClock('2026-01-05T09:00:00Z');
  const core = openRecord({ db, now: clock.now });
  const made = await createVault(PASSPHRASE, systemRandom, clock.now());
  const { cipher, backup } = sessionCiphers(made.keys);
  const result = await firstRun(core, { cipher: guarded(cipher), backup: guardedBackup(backup), vault: made.vault, wrappers: made.wrappers, settings: SETTINGS });
  assert.equal(result.kind, 'Saved');
  return { db, clock, core, code: made.recoveryCode };
}

async function rows(core: RecordCore): Promise<VaultRows> {
  const r = await vaultRows(core);
  if (!r) throw new Error('no vault');
  return r;
}

async function unlock(core: RecordCore, secret: Secret) {
  const opened = await unlockWithSecret(await rows(core), secret);
  if (opened.kind !== 'Unlocked') return opened.kind;
  const { cipher, backup } = sessionCiphers(opened.keys);
  await openSession(core, guarded(cipher), guardedBackup(backup));
  return opened.kind;
}

test('first run hands over the backup key, so the first lock already writes a snapshot', async () => {
  const { core } = await realRecord();
  assert.equal((await setSetting(core, 'cuesOn', false)).kind, 'Saved');
  const m = memoryFiles();
  assert.equal(await closeSession(core, { files: m.files, sleep: never, appVersion: '0.1.0' }), 'written');
  const file = m.store.get(LATEST);
  assert.ok(file);
  const { header, headerBytes, iv, ct } = readFrame(file);
  await backupCipher().openBody(headerBytes, iv, ct, header.wrappers, PASS);   // and it opens with the passphrase
});

test('before unlock the vault\'s rows are there to read, and nothing else is opened', async () => {
  const { core } = await realRecord();
  await core.lock();
  const r = await rows(core);
  assert.equal(r.vault.generation, 1);
  assert.equal(r.passphrase.method, 'passphrase');
  assert.equal(r.recovery.method, 'recovery');
  assert.equal(core.session, undefined);
  assert.equal(await vaultRows(openRecord({ db: freshDb(), now: Date.now })), undefined);
});

test('unlock: a wrong passphrase is told apart; the right one, or the recovery code, opens the record', async () => {
  const { core, code } = await realRecord();
  await setSetting(core, 'cuesOn', false);
  await core.lock();
  assert.equal(await unlock(core, { method: 'passphrase', text: 'CANARY wrong' }), 'WrongSecret');
  assert.equal(await unlock(core, { method: 'recovery', text: 'not a code' }), 'WrongSecret');
  assert.equal(core.session, undefined);
  assert.equal(await unlock(core, PASS), 'Unlocked');
  assert.equal(sessionOf(core)?.model.settings.cuesOn, false);
  await core.lock();
  assert.equal(await unlock(core, { method: 'recovery', text: code }), 'Unlocked');
  assert.equal(sessionOf(core)?.model.settings.cuesOn, false);
});

test('a copy that names another master key is refused as damaged, not as a wrong passphrase', async () => {
  const { core } = await realRecord();
  const r = await rows(core);
  assert.deepEqual(await unlockWithSecret({ ...r, passphrase: { ...r.passphrase, kid: r.recovery.ct.slice(0, 22) } }, PASS), { kind: 'Refused', reason: 'damaged' });
});

test('change the passphrase from an open session: one write, one generation on, the old one stops opening', async () => {
  const { core, code } = await realRecord();
  const before = await rows(core);
  assert.equal((await changePassphrase(before, { method: 'passphrase', text: 'CANARY wrong' }, 'CANARY new', systemRandom, 1)).kind, 'WrongSecret');
  const made = await changePassphrase(before, PASS, 'CANARY new', systemRandom, core.now());
  assert.equal(made.kind, 'Done');
  if (made.kind !== 'Done') return;
  assert.equal((await replaceWrapper(core, made.value)).kind, 'Saved');
  const after = await rows(core);
  assert.equal(after.vault.generation, 2);
  assert.equal(after.passphrase.generation, 2);
  assert.equal(after.recovery.generation, 1);
  assert.deepEqual(after.vault.keys, before.vault.keys, 'W and R are untouched');
  await core.lock();
  assert.equal(await unlock(core, PASS), 'WrongSecret');
  assert.equal(await unlock(core, { method: 'passphrase', text: 'CANARY new' }), 'Unlocked');
  await core.lock();
  assert.equal(await unlock(core, { method: 'recovery', text: code }), 'Unlocked');
});

test('a new recovery code from an open session: the new one opens, the old one no longer does', async () => {
  const { core, code } = await realRecord();
  const made = await replaceRecoveryCode(await rows(core), { method: 'recovery', text: code }, systemRandom, core.now());
  assert.equal(made.kind, 'Done');
  if (made.kind !== 'Done') return;
  assert.notEqual(made.value.code, code);
  assert.equal((await replaceWrapper(core, made.value.wrap)).kind, 'Saved');
  await core.lock();
  assert.equal(await unlock(core, { method: 'recovery', text: code }), 'WrongSecret');
  assert.equal(await unlock(core, { method: 'recovery', text: made.value.code }), 'Unlocked');
});

test('a changed secret marks the session, so the next lock writes a snapshot carrying the new copy', async () => {
  const { core } = await realRecord();
  const m = memoryFiles();
  const close = () => closeSession(core, { files: m.files, sleep: never, appVersion: '0.1.0' });
  await setSetting(core, 'cuesOn', false);
  assert.equal(await close(), 'written');
  assert.equal(await unlock(core, PASS), 'Unlocked');
  const made = await changePassphrase(await rows(core), PASS, 'CANARY new', systemRandom, core.now());
  if (made.kind !== 'Done') throw new Error(made.kind);
  await replaceWrapper(core, made.value);
  assert.equal(await close(), 'written');
  const { header } = readFrame(m.store.get(LATEST) ?? new Uint8Array());
  assert.equal(header.generation, 2);
  assert.deepEqual(header.wrappers.passphrase, (await rows(core)).passphrase);
});

test('replaceWrapper refuses a copy of another master key, or one that skips a generation', async () => {
  const { core } = await realRecord();
  const r = await rows(core);
  assert.deepEqual(await replaceWrapper(core, { ...r.passphrase, kid: 'another', generation: 2 }), { kind: 'Invalid', reason: 'a copy of another master key' });
  assert.deepEqual(await replaceWrapper(core, { ...r.passphrase, generation: 3 }), { kind: 'Invalid', reason: 'not the next generation' });
  assert.deepEqual(await replaceWrapper(core, { ...r.passphrase, generation: 1 }), { kind: 'Invalid', reason: 'not the next generation' });
  await core.lock();
  assert.deepEqual(await replaceWrapper(core, { ...r.passphrase, generation: 2 }), { kind: 'Locked' });
});

test('a change stopped before it is stored leaves the old passphrase opening everything', async () => {
  const { core } = await realRecord();
  const made = await changePassphrase(await rows(core), PASS, 'CANARY new', systemRandom, core.now());
  assert.equal(made.kind, 'Done');      // made and checked, then the phone dies: never stored
  await core.lock();
  assert.equal(await unlock(core, PASS), 'Unlocked');
  assert.equal((await rows(core)).vault.generation, 1);
});

test('withRawMasterKey zero-fills the key after the job, even when the job fails', async () => {
  const { core } = await realRecord();
  let seen: Uint8Array | undefined;
  await assert.rejects(withRawMasterKey(await rows(core), PASS, async raw => { seen = raw; throw new Error('job failed'); }), /job failed/);
  assert.ok(seen && seen.length === 32 && seen.every(b => b === 0));
  const done = await withRawMasterKey(await rows(core), PASS, async raw => raw.length);
  assert.deepEqual(done, { kind: 'Done', value: 32 });
});

test('the open session\'s keys stay unreadable through every change', async () => {
  const { core } = await realRecord();
  await core.lock();
  const opened = await unlockWithSecret(await rows(core), PASS);
  assert.equal(opened.kind, 'Unlocked');
  if (opened.kind !== 'Unlocked') return;
  for (const key of [opened.keys.w.key, opened.keys.r.key, opened.keys.backup]) assert.equal(key.extractable, false);
});
