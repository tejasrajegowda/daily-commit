import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkCode, finishNewCode, modesNow, newPassphrase, secretOpens, setMode, startNewCode } from '../../src/app/secretFlows.ts';
import { testDeps } from './deps.ts';
import { PASSPHRASE, realRecord, rowsOf } from './realRecord.ts';
import { unlockWithSecret } from '../../src/vault/vault.ts';

const PASS = { method: 'passphrase', text: PASSPHRASE } as const;
const opens = async (core: Parameters<typeof rowsOf>[0], method: 'passphrase' | 'recovery', text: string) =>
  (await unlockWithSecret(await rowsOf(core), { method, text })).kind === 'Unlocked';

test('a new passphrase under 15 characters is refused; a long one replaces the old', async () => {
  const r = await realRecord();
  const { deps } = testDeps(r.core);
  assert.deepEqual(await newPassphrase(deps, PASS, 'too short'), { kind: 'TooShort' });
  assert.equal((await newPassphrase(deps, { method: 'passphrase', text: 'CANARY wrong one' }, 'CANARY river stone lamp cloud')).kind, 'WrongSecret');
  assert.equal((await newPassphrase(deps, PASS, 'CANARY river stone lamp cloud')).kind, 'Saved');
  assert.equal(await opens(r.core, 'passphrase', 'CANARY river stone lamp cloud'), true);
  assert.equal(await opens(r.core, 'passphrase', PASSPHRASE), false);
});

test('a new recovery code stores nothing until typed back; then the old code stops opening it', async () => {
  const r = await realRecord();
  const { deps } = testDeps(r.core);
  const started = await startNewCode(deps, PASS);
  assert.equal(started.kind, 'Pending');
  if (started.kind !== 'Pending') return;
  assert.equal(await opens(r.core, 'recovery', r.code), true);              // nothing changed yet
  assert.deepEqual(await finishNewCode(deps, started.pending, r.code), { kind: 'CodeMismatch' });
  assert.equal((await finishNewCode(deps, started.pending, started.pending.code.toLowerCase())).kind, 'Saved');
  assert.equal(await opens(r.core, 'recovery', started.pending.code), true);
  assert.equal(await opens(r.core, 'recovery', r.code), false);
  assert.deepEqual(Object.keys(started.pending), ['code']);
});

test('checking the code changes nothing and says whether it opens the record', async () => {
  const r = await realRecord();
  const { deps } = testDeps(r.core);
  assert.equal(await checkCode(deps, r.code), true);
  assert.equal(await checkCode(deps, 'ABCDE ABCDE'), false);
});

test('an own code that the phone cannot confirm leaves the phone lock and the passphrase working', async () => {
  const r = await realRecord();
  const { deps, phone } = testDeps(r.core);
  assert.equal((await setMode(deps, PASS, 'phone-lock')).kind, 'Enrolled');
  phone.lieNext('not-a-key');
  assert.equal((await setMode(deps, PASS, 'own-code', '24681357')).kind, 'NotVerified');
  assert.deepEqual([...phone.copies.keys()], ['phone-lock']);
  assert.equal(await opens(r.core, 'passphrase', PASSPHRASE), true);
  assert.equal((await setMode(deps, PASS, 'own-code', '123')).kind, 'CodeTooShort');
});

test('secretOpens checks a passphrase without changing anything; modesNow reads what the phone holds', async () => {
  const r = await realRecord();
  const { deps } = testDeps(r.core);
  assert.equal(await secretOpens(deps, PASS), true);
  assert.equal(await secretOpens(deps, { method: 'passphrase', text: 'CANARY wrong one' }), false);
  assert.deepEqual(await modesNow(deps), []);
  await setMode(deps, PASS, 'phone-lock');
  assert.deepEqual(await modesNow(deps), ['phone-lock']);
});
