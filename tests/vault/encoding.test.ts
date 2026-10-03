import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as recordBytes from '../../src/record/bytes.ts';
import { fromBase64url, toBase64url, utf8Bytes } from '../../src/vault/encoding.ts';

test('the record\'s base64url is the lock\'s own, not a second copy', () => {
  assert.equal(recordBytes.toBase64url, toBase64url);
  assert.equal(recordBytes.fromBase64url, fromBase64url);
});

test('utf8Bytes is UTF-8 over a plain ArrayBuffer, as WebCrypto wants', () => {
  assert.equal(Buffer.from(utf8Bytes('é')).toString('hex'), 'c3a9');
  assert.ok(utf8Bytes('x').buffer instanceof ArrayBuffer);
  assert.ok(fromBase64url('AAE').buffer instanceof ArrayBuffer);
});
