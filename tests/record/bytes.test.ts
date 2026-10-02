import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fc from 'fast-check';
import { fromBase64url, jsonBytes, parseJsonBytes, toBase64url } from '../../src/record/bytes.ts';

test('base64url has no padding and no + or /', () => {
  assert.equal(toBase64url(new TextEncoder().encode('hello')), 'aGVsbG8');
  assert.equal(toBase64url(Uint8Array.of(0xfb, 0xff)), '-_8');
  assert.deepEqual(fromBase64url('-_8'), Uint8Array.of(0xfb, 0xff));
});

test('any bytes survive the trip through base64url', () => {
  fc.assert(fc.property(fc.uint8Array({ maxLength: 300 }), bytes => {
    assert.deepEqual(fromBase64url(toBase64url(bytes)), bytes);
  }), { numRuns: 500 });
});

test('text that is not base64url is refused', () => {
  assert.throws(() => fromBase64url('ab+c'), /not base64url/);
  assert.throws(() => fromBase64url('abcde'), /not base64url/);
});

test('JSON bytes are UTF-8, and damaged bytes throw', () => {
  assert.deepEqual(parseJsonBytes(jsonBytes({ a: 'CANARY-TEST é' })), { a: 'CANARY-TEST é' });
  assert.throws(() => parseJsonBytes(Uint8Array.of(0xff, 0xfe)));
});
