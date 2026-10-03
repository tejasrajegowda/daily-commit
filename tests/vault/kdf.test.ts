import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hkdfSync, pbkdf2Sync } from 'node:crypto';
import { CipherError } from '../../src/vault/cipher.ts';
import { fromBase64url } from '../../src/vault/encoding.ts';
import {
  checkKdf, deriveKek, MAX_ITERATIONS, newPassphraseKdf, newRecoveryKdf, passphraseBytes, PBKDF2_ITERATIONS, type KdfSettings,
} from '../../src/vault/kdf.ts';
import { NORM_VECTORS, SALT_44 } from './vectors.ts';

const hex = (b: Uint8Array): string => Buffer.from(b).toString('hex');
const fill = (byte: number) => (n: number) => new Uint8Array(n).fill(byte);

const PASS: KdfSettings = { alg: 'pbkdf2-sha256', iterations: PBKDF2_ITERATIONS, salt: SALT_44, norm: 'utf8-nfc-trim-v1' };
const REC: KdfSettings = { alg: 'hkdf-sha256', salt: SALT_44, info: 'dc/recovery/v1' };

/** True if `kek` is the AES-GCM key with these raw bytes: what one locks, the other opens. */
async function sameKey(kek: CryptoKey, raw: Uint8Array<ArrayBuffer>): Promise<boolean> {
  const other = await crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt']);
  const iv = new Uint8Array(12);
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, other, Uint8Array.of(1, 2, 3));
  try {
    return hex(new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, kek, ct))) === '010203';
  } catch {
    return false;
  }
}

test('golden: a passphrase is NFC, trimmed, then UTF-8', () => {
  for (const { text, bytes } of NORM_VECTORS) assert.equal(hex(passphraseBytes(text)), bytes, JSON.stringify(text));
  assert.equal(hex(passphraseBytes('café')), hex(passphraseBytes('café')));   // composed and decomposed agree
});

test('new settings use the constants and fresh salt from the random source', () => {
  assert.deepEqual(newPassphraseKdf(fill(0x44)), PASS);
  assert.deepEqual(newRecoveryKdf(fill(0x44)), REC);
  assert.equal(PBKDF2_ITERATIONS, 600_000);
  assert.notEqual(newPassphraseKdf(n => crypto.getRandomValues(new Uint8Array(n))).salt, newPassphraseKdf(n => crypto.getRandomValues(new Uint8Array(n))).salt);
});

test('the passphrase KEK is PBKDF2-SHA256 over the normalised bytes', async () => {
  const kek = await deriveKek(PASS, { passphrase: '  CANARY passphrase é ' });
  const expected = pbkdf2Sync(Buffer.from('CANARY passphrase é'.normalize('NFC')), fromBase64url(SALT_44), PBKDF2_ITERATIONS, 32, 'sha256');
  assert.ok(await sameKey(kek, new Uint8Array(expected)));
  assert.equal(kek.extractable, false);
});

test('the recovery KEK is HKDF-SHA256 with the info dc/recovery/v1', async () => {
  const code = new Uint8Array(25).fill(7);
  const kek = await deriveKek(REC, { code });
  const expected = hkdfSync('sha256', code, fromBase64url(SALT_44), 'dc/recovery/v1', 32);
  assert.ok(await sameKey(kek, new Uint8Array(expected)));
  assert.deepEqual(code, new Uint8Array(25).fill(7), 'the caller\'s code is left as it was');
});

test('a different passphrase or salt gives a different KEK', async () => {
  const raw = new Uint8Array(pbkdf2Sync(Buffer.from('CANARY one'), fromBase64url(SALT_44), PBKDF2_ITERATIONS, 32, 'sha256'));
  assert.equal(await sameKey(await deriveKek(PASS, { passphrase: 'CANARY two' }), raw), false);
  assert.equal(await sameKey(await deriveKek({ ...PASS, salt: newPassphraseKdf(fill(0x45)).salt }, { passphrase: 'CANARY one' }), raw), false);
});

test('checkKdf: what this app writes is ok', () => {
  assert.equal(checkKdf(PASS), 'ok');
  assert.equal(checkKdf(REC), 'ok');
  assert.equal(checkKdf({ ...PASS, iterations: MAX_ITERATIONS }), 'ok');
});

test('checkKdf: settings no app ever wrote are damaged', () => {
  for (const bad of [
    null, 'pbkdf2', [], {}, { alg: 7 },
    { ...PASS, iterations: PBKDF2_ITERATIONS - 1 }, { ...PASS, iterations: 1 }, { ...PASS, iterations: 600000.5 }, { ...PASS, iterations: '600000' },
    { ...PASS, salt: 'not base64url!' }, { ...PASS, salt: newPassphraseKdf(fill(1)).salt.slice(4) }, { ...PASS, norm: undefined },
    { ...REC, salt: undefined }, { ...REC, info: 5 },
  ]) assert.equal(checkKdf(bad), 'damaged', JSON.stringify(bad));
});

test('checkKdf: settings a later app might write need a newer app', () => {
  for (const later of [
    { ...PASS, iterations: MAX_ITERATIONS + 1 }, { ...PASS, iterations: 2 ** 31 },
    { ...PASS, norm: 'utf8-nfkc-v2' }, { ...REC, info: 'dc/recovery/v2' }, { alg: 'argon2id', salt: SALT_44 },
  ]) assert.equal(checkKdf(later), 'newer-app', JSON.stringify(later));
});

test('hostile settings are refused before any work is done', async () => {
  const started = performance.now();
  await assert.rejects(deriveKek({ ...PASS, iterations: 2 ** 31 }, { passphrase: 'CANARY' }), (e: unknown) => e instanceof CipherError && e.failure === 'newer-app');
  await assert.rejects(deriveKek({ ...PASS, iterations: 1 }, { passphrase: 'CANARY' }), (e: unknown) => e instanceof CipherError && e.failure === 'damaged');
  assert.ok(performance.now() - started < 50, 'nothing was stretched');
});

test('a passphrase never opens with recovery settings, nor a code with passphrase settings', async () => {
  await assert.rejects(deriveKek(REC, { passphrase: 'CANARY' }), CipherError);
  await assert.rejects(deriveKek(PASS, { code: new Uint8Array(25) }), CipherError);
});
