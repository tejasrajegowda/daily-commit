import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CipherError, type EnvelopeContext } from '../../src/vault/cipher.ts';
import { rowCipher } from '../../src/vault/rowCipher.ts';
import { TABLE_TAGS } from '../../src/vault/tags.ts';
import { openParts, sealParts } from '../../src/record/payload.ts';
import { counterRandom, GOLDEN_ENVELOPE, OBSERVATION_ID, ROW_ID } from './vectors.ts';
import { flipByte, freshVault, goldenVault, utf8 } from './helpers.ts';

const OBS: EnvelopeContext = { table: TABLE_TAGS.observations, id: OBSERVATION_ID, slot: 'r' };
const isFailure = (failure: string) => (e: unknown) => e instanceof CipherError && e.failure === failure;

test('golden: the record key seals an observation exactly as the reference does', async () => {
  const { keys } = await goldenVault();
  const env = await rowCipher(keys, counterRandom(200)).seal(OBS, utf8('CANARY-TEST'));
  assert.deepEqual(env, GOLDEN_ENVELOPE);
  assert.equal(new TextDecoder().decode(await rowCipher(keys).open(OBS, env)), 'CANARY-TEST');
});

test('every seal draws a fresh IV, so the same value never looks the same twice', async () => {
  const cipher = rowCipher((await goldenVault()).keys);
  const a = await cipher.seal(OBS, utf8('CANARY-TEST'));
  const b = await cipher.seal(OBS, utf8('CANARY-TEST'));
  assert.notEqual(a.iv, b.iv);
  assert.notEqual(a.ct, b.ct);
  assert.deepEqual(await cipher.open(OBS, a), await cipher.open(OBS, b));
});

test('r is sealed with the record key and w with the words key', async () => {
  const { keys } = await goldenVault();
  const cipher = rowCipher(keys);
  assert.equal((await cipher.seal(OBS, utf8('x'))).k, keys.r.id);
  assert.equal((await cipher.seal({ ...OBS, slot: 'w' }, utf8('x'))).k, keys.w.id);
});

test('tamper: a value moved to another row, table or slot, or changed by one byte, refuses as damaged', async () => {
  const cipher = rowCipher((await goldenVault()).keys);
  const env = await cipher.seal(OBS, utf8('CANARY-TEST'));
  await assert.rejects(cipher.open({ ...OBS, id: `${ROW_ID}|2026-01-06` }, env), isFailure('damaged'));
  await assert.rejects(cipher.open({ ...OBS, table: TABLE_TAGS.days }, env), isFailure('damaged'));
  await assert.rejects(cipher.open({ ...OBS, slot: 'w' }, env), isFailure('damaged'));
  await assert.rejects(cipher.open(OBS, { ...env, ct: flipByte(env.ct) }), isFailure('damaged'));
  await assert.rejects(cipher.open(OBS, { ...env, ct: flipByte(env.ct, 12) }), isFailure('damaged'));   // inside the tag
  await assert.rejects(cipher.open(OBS, { ...env, iv: flipByte(env.iv) }), isFailure('damaged'));
  await assert.rejects(cipher.open(OBS, { ...env, ct: env.ct.slice(0, 8) }), isFailure('damaged'));    // cut short
  await assert.rejects(cipher.open(OBS, { ...env, iv: 'not base64url!' }), isFailure('damaged'));
});

test('a value from another vault says so; a newer format says so; neither says damaged', async () => {
  const mine = rowCipher((await goldenVault()).keys);
  const theirs = rowCipher((await freshVault()).keys);
  const env = await theirs.seal(OBS, utf8('CANARY-TEST'));
  await assert.rejects(mine.open(OBS, env), isFailure('other-vault'));
  const own = await mine.seal(OBS, utf8('CANARY-TEST'));
  await assert.rejects(mine.open(OBS, { ...own, v: 2 }), isFailure('newer-app'));
  await assert.rejects(mine.open(OBS, { ...own, v: 0 }), isFailure('damaged'));
  await assert.rejects(mine.open(OBS, { ...own, v: 1.5 }), isFailure('damaged'));
});

test('the real cipher fits the record\'s door: a habit\'s fields go in and come out', async () => {
  const cipher = rowCipher((await goldenVault()).keys);
  const parts = { plain: { id: ROW_ID }, r: { name: 'CANARY-TEST walk', kind: 'tri' } };
  const slots = await sealParts(cipher, 'habits', parts);
  assert.ok(slots.r && !slots.w);
  assert.deepEqual(await openParts(cipher, 'habits', parts.plain, slots), { r: { name: 'CANARY-TEST walk', kind: 'tri', pv: 1 } });
  await assert.rejects(openParts(cipher, 'habits', { id: `${ROW_ID}0` }, slots), isFailure('damaged'));
});
