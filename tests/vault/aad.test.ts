import { test } from 'node:test';
import assert from 'node:assert/strict';
import { aad, dkAad, envAad, sortedJson, wrapAad, PURPOSES } from '../../src/vault/aad.ts';
import { TABLE_TAGS } from '../../src/vault/tags.ts';
import { AAD_VECTORS, KDF_SAMPLE, KEY_11, KEY_22, KEY_33, OBSERVATION_ID, ROW_ID } from './vectors.ts';

const hex = (b: Uint8Array): string => Buffer.from(b).toString('hex');

test('an AAD is "dc1", then each part behind its 2-byte big-endian length', () => {
  // built by hand from the rule, byte by byte
  assert.equal(hex(aad(['dk', '1'])), '646331' + '0002' + '646b' + '0001' + '31');
  assert.equal(hex(aad([])), '646331');
  assert.equal(hex(aad(['é'])), '646331' + '0002' + 'c3a9');   // the length counts bytes, not letters
});

test('the purposes are frozen, and exactly these', () => {
  assert.ok(Object.isFrozen(PURPOSES));
  assert.deepEqual({ ...PURPOSES }, { env: 'env', wrap: 'wrap', dk: 'dk' });
});

test('golden: an observation, bound to its habit and date', () => {
  assert.equal(hex(envAad(1, KEY_11, { table: TABLE_TAGS.observations, id: OBSERVATION_ID, slot: 'r' })), AAD_VECTORS.envObservation);
});

test('golden: a diary page, in the words slot', () => {
  assert.equal(hex(envAad(1, KEY_22, { table: TABLE_TAGS.entries, id: ROW_ID, slot: 'w' })), AAD_VECTORS.envEntry);
});

test('golden: the passphrase copy of the master key, its KDF settings in sorted order', () => {
  assert.equal(hex(wrapAad('passphrase', KEY_33, KDF_SAMPLE)), AAD_VECTORS.wrapPassphrase);
});

test('golden: the words key, wrapped under the master key', () => {
  assert.equal(hex(dkAad(1, KEY_22, KEY_33)), AAD_VECTORS.dkWords);
});

test('every part is bound on its own: a change to any one changes the AAD', () => {
  assert.notEqual(hex(aad(['ab', 'c'])), hex(aad(['a', 'bc'])));
  const ctx = { table: TABLE_TAGS.habits, id: ROW_ID, slot: 'r' } as const;
  const base = hex(envAad(1, KEY_11, ctx));
  assert.notEqual(base, hex(envAad(1, KEY_11, { ...ctx, slot: 'w' })));
  assert.notEqual(base, hex(envAad(1, KEY_11, { ...ctx, table: TABLE_TAGS.cues })));
  assert.notEqual(base, hex(envAad(1, KEY_11, { ...ctx, id: OBSERVATION_ID })));
  assert.notEqual(base, hex(envAad(2, KEY_11, ctx)));
  assert.notEqual(base, hex(envAad(1, KEY_22, ctx)));
  assert.notEqual(hex(wrapAad('passphrase', KEY_33, KDF_SAMPLE)), hex(wrapAad('recovery', KEY_33, KDF_SAMPLE)));
  assert.notEqual(hex(wrapAad('passphrase', KEY_33, KDF_SAMPLE)), hex(wrapAad('passphrase', KEY_33, { ...KDF_SAMPLE, iterations: 600001 })));
});

test('a part longer than 65,535 bytes is refused', () => {
  assert.doesNotThrow(() => aad(['x'.repeat(0xffff)]));
  assert.throws(() => aad(['x'.repeat(0x10000)]), RangeError);
});

test('sorted JSON sorts keys at every depth and keeps arrays in order', () => {
  assert.equal(sortedJson({ b: 1, a: { d: [3, 1], c: null } }), '{"a":{"c":null,"d":[3,1]},"b":1}');
  assert.equal(sortedJson(KDF_SAMPLE), '{"alg":"pbkdf2-sha256","iterations":600000,"norm":"utf8-nfc-trim-v1","salt":"RERERERERERERERERERERA"}');
});
