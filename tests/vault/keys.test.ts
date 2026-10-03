import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CipherError } from '../../src/vault/cipher.ts';
import { createVault, openKeys, unwrapMaster, wrapMaster, SecretError } from '../../src/vault/keys.ts';
import { readCode } from '../../src/vault/recovery.ts';
import { counterRandom, GOLDEN_CODE, GOLDEN_MADE, GOLDEN_PASSPHRASE, GOLDEN_VAULT, GOLDEN_WRAPPERS } from './vectors.ts';
import { flipByte, freshVault, goldenVault, hex } from './helpers.ts';

/** The golden master key: the first 32 bytes of the counting source. */
const GOLDEN_MASTER = hex(Uint8Array.from({ length: 32 }, (_, i) => i));

const isFailure = (failure: string) => (e: unknown) => e instanceof CipherError && e.failure === failure;

test('golden: a vault made from a fixed random source is exactly the reference\'s', async () => {
  const made = await goldenVault();
  assert.deepEqual(made.vault, GOLDEN_VAULT);
  assert.deepEqual(made.wrappers, GOLDEN_WRAPPERS);
  assert.equal(made.recoveryCode, GOLDEN_CODE);
});

test('the passphrase copy and the recovery copy each open to the same master key', async () => {
  const { wrappers: [pass, rec], recoveryCode } = await goldenVault();
  assert.equal(hex(await unwrapMaster(pass, { passphrase: GOLDEN_PASSPHRASE })), GOLDEN_MASTER);
  assert.equal(hex(await unwrapMaster(pass, { passphrase: `  ${GOLDEN_PASSPHRASE}　` })), GOLDEN_MASTER);   // trimmed
  const code = readCode(recoveryCode);
  assert.ok(code.ok);
  assert.equal(hex(await unwrapMaster(rec, { code: code.bytes })), GOLDEN_MASTER);
});

test('a wrong passphrase or code fails, and nothing stored could check one without the stretch', async () => {
  const { vault, wrappers: [pass, rec] } = await goldenVault();
  await assert.rejects(unwrapMaster(pass, { passphrase: 'CANARY wrong' }), SecretError);
  await assert.rejects(unwrapMaster(rec, { code: new Uint8Array(25) }), SecretError);
  // no hash, no verifier, no hint: these are every field there is
  assert.deepEqual(Object.keys(pass).sort(), ['created_at', 'ct', 'generation', 'iv', 'kdf', 'kid', 'method', 'updated_at']);
  assert.deepEqual(Object.keys(pass.kdf).sort(), ['alg', 'iterations', 'norm', 'salt']);
  assert.deepEqual(Object.keys(rec.kdf).sort(), ['alg', 'info', 'salt']);
  assert.deepEqual(Object.keys(vault).sort(), ['created_at', 'generation', 'key', 'keys', 'kid', 'updated_at', 'vault_id']);
});

test('a copy changed anywhere refuses to open; to the screen it is the same as a wrong secret', async () => {
  const { wrappers: [pass] } = await goldenVault();
  const secret = { passphrase: GOLDEN_PASSPHRASE };
  await assert.rejects(unwrapMaster({ ...pass, ct: flipByte(pass.ct) }, secret), SecretError);
  await assert.rejects(unwrapMaster({ ...pass, iv: flipByte(pass.iv) }, secret), SecretError);
  await assert.rejects(unwrapMaster({ ...pass, kid: flipByte(pass.kid) }, secret), SecretError);
  await assert.rejects(unwrapMaster({ ...pass, method: 'recovery' }, secret), SecretError);   // the method is bound in too
  await assert.rejects(unwrapMaster({ ...pass, kdf: { ...pass.kdf, iterations: 600_001 } }, secret), SecretError);
  await assert.rejects(unwrapMaster({ ...pass, kdf: { ...pass.kdf, iterations: 1 } }, secret), isFailure('damaged'));
  await assert.rejects(unwrapMaster({ ...pass, ct: 'not base64url!' }, secret), isFailure('damaged'));
});

test('an open vault holds W, R and the backup key, none of them readable', async () => {
  const { keys, vault } = await goldenVault();
  assert.equal(keys.kid, vault.kid);
  assert.equal(keys.w.id, vault.keys.w.id);
  assert.equal(keys.r.id, vault.keys.r.id);
  for (const key of [keys.w.key, keys.r.key, keys.backup]) {
    assert.equal(key.extractable, false);
    await assert.rejects(crypto.subtle.exportKey('raw', key));
  }
});

test('opening a vault zero-fills the master key\'s bytes', async () => {
  const { vault, wrappers: [pass] } = await goldenVault();
  const raw = await unwrapMaster(pass, { passphrase: GOLDEN_PASSPHRASE });
  await openKeys(raw, vault);
  assert.ok(raw.every(b => b === 0));
});

test('making a vault zero-fills the master key, W, R and the recovery code it drew', async () => {
  const counting = counterRandom();
  const handed: Uint8Array[] = [];
  await createVault(GOLDEN_PASSPHRASE, n => { const b = counting(n); handed.push(b); return b; }, GOLDEN_MADE);
  for (const at of [0, 1, 2, 7]) assert.ok(handed[at]?.every(b => b === 0), `draw ${at} was left behind`);
  assert.ok(handed[3]?.some(b => b !== 0), 'the kid is not a secret and is kept');
});

test('another vault\'s master key does not open this vault\'s W and R', async () => {
  const mine = await goldenVault();
  const theirs = await freshVault();
  const raw = await unwrapMaster(theirs.wrappers[0], { passphrase: 'CANARY other passphrase' });
  await assert.rejects(openKeys(raw, mine.vault), isFailure('damaged'));
});

test('a W or R wrap that names another master key, or a newer format, says so', async () => {
  const { vault, wrappers: [pass] } = await goldenVault();
  const raw = () => unwrapMaster(pass, { passphrase: GOLDEN_PASSPHRASE });
  const w = vault.keys.w;
  await assert.rejects(openKeys(await raw(), { ...vault, keys: { ...vault.keys, w: { ...w, wrap: { ...w.wrap, k: flipByte(w.wrap.k) } } } }), isFailure('other-vault'));
  await assert.rejects(openKeys(await raw(), { ...vault, keys: { ...vault.keys, w: { ...w, wrap: { ...w.wrap, v: 2 } } } }), isFailure('newer-app'));
  await assert.rejects(openKeys(await raw(), { ...vault, keys: { ...vault.keys, w: { ...w, wrap: { ...w.wrap, ct: flipByte(w.wrap.ct, 5) } } } }), isFailure('damaged'));
  await assert.rejects(openKeys(await raw(), { ...vault, keys: { ...vault.keys, w: { ...w, id: vault.keys.r.id } } }), isFailure('damaged'));   // W's wrap under R's id
});

test('a new copy carries its generation, fresh settings, and opens to the key it wrapped', async () => {
  const { wrappers: [pass] } = await goldenVault();
  const raw = await unwrapMaster(pass, { passphrase: GOLDEN_PASSPHRASE });
  const next = await wrapMaster(raw, 'passphrase', pass.kid, 2, { passphrase: 'CANARY new passphrase' }, n => crypto.getRandomValues(new Uint8Array(n)), GOLDEN_MADE + 1);
  assert.equal(next.generation, 2);
  assert.equal(next.updated_at, GOLDEN_MADE + 1);
  assert.notEqual(next.kdf.salt, pass.kdf.salt);
  assert.equal(hex(await unwrapMaster(next, { passphrase: 'CANARY new passphrase' })), GOLDEN_MASTER);
  await assert.rejects(unwrapMaster(next, { passphrase: GOLDEN_PASSPHRASE }), SecretError);
});

test('two vaults from the system\'s random source share nothing', async () => {
  const [a, b] = await Promise.all([freshVault(), freshVault()]);
  assert.notEqual(a.vault.vault_id, b.vault.vault_id);
  assert.notEqual(a.vault.kid, b.vault.kid);
  assert.notEqual(a.vault.keys.w.id, b.vault.keys.w.id);
  assert.notEqual(a.recoveryCode, b.recoveryCode);
});
