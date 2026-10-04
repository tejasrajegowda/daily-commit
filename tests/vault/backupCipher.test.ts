import { test } from 'node:test';
import assert from 'node:assert/strict';
import { backupCipher } from '../../src/vault/backupCipher.ts';
import { BackupError, CipherError, type Secret } from '../../src/vault/cipher.ts';
import { rowCipher } from '../../src/vault/rowCipher.ts';
import { TABLE_TAGS } from '../../src/vault/tags.ts';
import { GOLDEN_BODY, GOLDEN_CODE, GOLDEN_PASSPHRASE, OBSERVATION_ID } from './vectors.ts';
import { flipByte, freshVault, goldenVault, hex, utf8 } from './helpers.ts';

const HEADER = utf8('{"h":1}');
const IV = new Uint8Array(12).fill(0x77);
const PASS: Secret = { method: 'passphrase', text: GOLDEN_PASSPHRASE };
const OBS = { table: TABLE_TAGS.observations, id: OBSERVATION_ID, slot: 'r' } as const;

async function golden() {
  const made = await goldenVault();
  const [passphrase, recovery] = made.wrappers;
  return { made, wraps: { passphrase, recovery }, sealed: await backupCipher(made.keys).sealBody(utf8('CANARY-TEST body'), HEADER, IV) };
}

const refusedAs = (reason: string) => (e: unknown) => e instanceof BackupError && e.reason === reason;

test('golden: a body is sealed under the backup key exactly as the reference does', async () => {
  assert.equal(hex((await golden()).sealed), GOLDEN_BODY);
});

test('a body opens with the passphrase, and separately with the recovery code however it is typed', async () => {
  const { wraps, sealed } = await golden();
  const opener = backupCipher();   // no keys: a phone never set up
  assert.equal(new TextDecoder().decode((await opener.openBody(HEADER, IV, sealed, wraps, PASS)).body), 'CANARY-TEST body');
  const sloppy = GOLDEN_CODE.toLowerCase().replace(/ /g, '-');
  assert.equal(new TextDecoder().decode((await opener.openBody(HEADER, IV, sealed, wraps, { method: 'recovery', text: sloppy })).body), 'CANARY-TEST body');
});

test('a wrong passphrase, a wrong code, or text that isn\'t a code is a wrong secret', async () => {
  const { wraps, sealed } = await golden();
  const opener = backupCipher();
  await assert.rejects(opener.openBody(HEADER, IV, sealed, wraps, { method: 'passphrase', text: 'CANARY wrong' }), refusedAs('wrong-secret'));
  await assert.rejects(opener.openBody(HEADER, IV, sealed, wraps, { method: 'recovery', text: '00000 00000 00000 00000 00000 00000 00000 00000 0' }), refusedAs('wrong-secret'));
  await assert.rejects(opener.openBody(HEADER, IV, sealed, wraps, { method: 'recovery', text: 'not a code' }), refusedAs('wrong-secret'));
});

test('a changed header, a changed body, a body cut short, or another IV is damaged', async () => {
  const { wraps, sealed } = await golden();
  const opener = backupCipher();
  await assert.rejects(opener.openBody(utf8('{"h":2}'), IV, sealed, wraps, PASS), refusedAs('damaged'));
  const flipped = sealed.slice();
  flipped[3] = (flipped[3] ?? 0) ^ 1;
  await assert.rejects(opener.openBody(HEADER, IV, flipped, wraps, PASS), refusedAs('damaged'));
  await assert.rejects(opener.openBody(HEADER, IV, sealed.slice(0, 10), wraps, PASS), refusedAs('damaged'));
  await assert.rejects(opener.openBody(HEADER, new Uint8Array(12), sealed, wraps, PASS), refusedAs('damaged'));
});

test('hostile settings in a file are refused at once, with the right words', async () => {
  const { wraps, sealed } = await golden();
  const opener = backupCipher();
  const started = performance.now();
  const withKdf = (kdf: object) => ({ ...wraps, passphrase: { ...wraps.passphrase, kdf } });
  await assert.rejects(opener.openBody(HEADER, IV, sealed, withKdf({ ...wraps.passphrase.kdf, iterations: 2 ** 31 }), PASS), refusedAs('newer-app'));
  await assert.rejects(opener.openBody(HEADER, IV, sealed, withKdf({ ...wraps.passphrase.kdf, iterations: 1 }), PASS), refusedAs('damaged'));
  await assert.rejects(opener.openBody(HEADER, IV, sealed, withKdf({ alg: 'argon2id' }), PASS), refusedAs('newer-app'));
  assert.ok(performance.now() - started < 50, 'nothing was stretched');
});

test('a damaged passphrase copy reads as a wrong passphrase, and the recovery code still opens the file', async () => {
  const { wraps, sealed } = await golden();
  const opener = backupCipher();
  const broken = { ...wraps, passphrase: { ...wraps.passphrase, ct: flipByte(wraps.passphrase.ct) } };
  await assert.rejects(opener.openBody(HEADER, IV, sealed, broken, PASS), refusedAs('wrong-secret'));
  await opener.openBody(HEADER, IV, sealed, broken, { method: 'recovery', text: GOLDEN_CODE });
});

test('test-open: a value of this vault opens; one moved, or another vault\'s, rejects', async () => {
  const { made, wraps, sealed } = await golden();
  const opened = await backupCipher().openBody(HEADER, IV, sealed, wraps, PASS);
  const env = await rowCipher(made.keys).seal(OBS, utf8('CANARY-TEST'));
  await opened.testOpen(made.vault, OBS, env);
  await assert.rejects(opened.testOpen(made.vault, { ...OBS, id: 'moved' }, env), CipherError);
  const foreign = await rowCipher((await freshVault()).keys).seal(OBS, utf8('CANARY-TEST'));
  await assert.rejects(opened.testOpen(made.vault, OBS, foreign), (e: unknown) => e instanceof CipherError && e.failure === 'other-vault');
});

test('test-open unwraps W and R once for a whole file, not once per value', async (t) => {
  const { made, wraps, sealed } = await golden();
  const opened = await backupCipher().openBody(HEADER, IV, sealed, wraps, PASS);
  const env = await rowCipher(made.keys).seal(OBS, utf8('CANARY-TEST'));
  const unwrap = t.mock.method(crypto.subtle, 'unwrapKey');
  await Promise.all(Array.from({ length: 50 }, () => opened.testOpen(made.vault, OBS, env)));
  assert.equal(unwrap.mock.callCount(), 2);
});

test('without the open vault\'s keys a backup cipher can open but never seal', async () => {
  await assert.rejects(backupCipher().sealBody(utf8('x'), HEADER, IV), /only opens/);
});
