import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fc from 'fast-check';
import { newRecoveryCode, printCode, readCode, RECOVERY_BYTES } from '../../src/vault/recovery.ts';
import { RECOVERY_VECTORS } from './vectors.ts';

const hexBytes = (h: string): Uint8Array => Uint8Array.from(Buffer.from(h, 'hex'));

test('golden: 25 bytes print as 8 groups of 5 and a check symbol', () => {
  for (const { bytes, text } of RECOVERY_VECTORS) assert.equal(printCode(hexBytes(bytes)), text);
});

test('golden: each printed code reads back to its bytes', () => {
  for (const { bytes, text } of RECOVERY_VECTORS) assert.deepEqual(readCode(text), { ok: true, bytes: hexBytes(bytes) });
});

test('reading forgives case, I and L for 1, O for 0, spaces and dashes', () => {
  const { bytes, text } = RECOVERY_VECTORS[2] ?? assert.fail();   // '000G4 0R40M … HC5RR U'
  const sloppy = text.toLowerCase().replace(/0/g, 'o').replace(/ /g, '-');
  assert.deepEqual(readCode(`  ${sloppy} `), { ok: true, bytes: hexBytes(bytes) });
  assert.deepEqual(readCode(text.replace(/ /g, '')), { ok: true, bytes: hexBytes(bytes) });
  const ones = printCode(new Uint8Array(RECOVERY_BYTES).fill(0x42));   // has a 1 in it
  assert.ok(ones.includes('1'));
  assert.deepEqual(readCode(ones.replace(/1/g, 'l')), { ok: true, bytes: new Uint8Array(RECOVERY_BYTES).fill(0x42) });
  assert.deepEqual(readCode(ones.replace(/1/g, 'I')), { ok: true, bytes: new Uint8Array(RECOVERY_BYTES).fill(0x42) });
});

test('every check symbol, the five extra ones included, is accepted where it belongs', () => {
  const seen = new Set<string>();
  fc.assert(fc.property(fc.uint8Array({ minLength: RECOVERY_BYTES, maxLength: RECOVERY_BYTES }), bytes => {
    const text = printCode(bytes);
    seen.add(text.slice(-1));
    assert.deepEqual(readCode(text), { ok: true, bytes });
  }), { numRuns: 2000 });
  for (const extra of ['*', '~', '$', '=', 'U']) assert.ok(seen.has(extra), `never saw ${extra}`);
});

test('a lower-case u is read as the check symbol U', () => {
  const { bytes, text } = RECOVERY_VECTORS[2] ?? assert.fail();
  assert.deepEqual(readCode(text.slice(0, -1) + 'u'), { ok: true, bytes: hexBytes(bytes) });
});

test('one character changed is caught by the check symbol', () => {
  fc.assert(fc.property(fc.uint8Array({ minLength: RECOVERY_BYTES, maxLength: RECOVERY_BYTES }), fc.nat(39), fc.nat(31), (bytes, at, by) => {
    const chars = printCode(bytes).replace(/ /g, '');
    const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
    const changed = alphabet[(alphabet.indexOf(chars.charAt(at)) + 1 + (by % 31)) % 32] ?? '';
    const typed = chars.slice(0, at) + changed + chars.slice(at + 1);
    assert.deepEqual(readCode(typed), { ok: false, problem: 'check' });
  }), { numRuns: 1000 });
});

test('two neighbouring characters swapped is caught', () => {
  const { text } = RECOVERY_VECTORS[2] ?? assert.fail();
  const chars = text.replace(/ /g, '');
  const real = chars.slice(0, 3) + chars.charAt(4) + chars.charAt(3) + chars.slice(5);   // 'G' and '4'
  assert.deepEqual(readCode(real), { ok: false, problem: 'check' });
});

test('too short, too long, or a letter Crockford leaves out, says which', () => {
  const { text } = RECOVERY_VECTORS[2] ?? assert.fail();
  assert.deepEqual(readCode(text.slice(0, -2)), { ok: false, problem: 'length' });
  assert.deepEqual(readCode(`${text}0`), { ok: false, problem: 'length' });
  assert.deepEqual(readCode(''), { ok: false, problem: 'length' });
  assert.deepEqual(readCode(`U${text.replace(/ /g, '').slice(1)}`), { ok: false, problem: 'character' });   // U is only a check symbol
  assert.deepEqual(readCode(`*${text.replace(/ /g, '').slice(1)}`), { ok: false, problem: 'character' });
  assert.deepEqual(readCode(text.slice(0, -1) + '#'), { ok: false, problem: 'character' });
});

test('a new code is 25 bytes from the random source, printed', () => {
  const fixed = (n: number) => new Uint8Array(n).fill(0xff);
  assert.deepEqual(newRecoveryCode(fixed), { text: RECOVERY_VECTORS[1]?.text, bytes: fixed(25) });
  const a = newRecoveryCode(n => crypto.getRandomValues(new Uint8Array(n)));
  const b = newRecoveryCode(n => crypto.getRandomValues(new Uint8Array(n)));
  assert.notEqual(a.text, b.text);
});

test('printing refuses anything but 25 bytes', () => {
  assert.throws(() => printCode(new Uint8Array(24)), RangeError);
});

test('a printed code never holds I, L or O, check symbol included, as the first-run screen says', () => {
  fc.assert(fc.property(fc.uint8Array({ minLength: RECOVERY_BYTES, maxLength: RECOVERY_BYTES }), bytes => {
    assert.doesNotMatch(printCode(bytes), /[ILO]/);
  }));
  const endsInU = Array.from({ length: 400 }, (_, i) => printCode(new Uint8Array(RECOVERY_BYTES).fill(i % 256).map((b, j) => (b * 31 + j * i) & 255)))
    .some(c => c.endsWith('U'));
  assert.ok(endsInU, 'the check symbol can be U, so the screen must not promise "no U"');
});
