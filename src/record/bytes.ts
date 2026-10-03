// JSON as bytes, and base64url, which is how every binary value is stored, in the database and
// inside a backup alike. base64url is the lock's own, re-exported so the record has one door for both.
import { utf8Bytes } from '../vault/encoding.ts';

export { fromBase64url, toBase64url } from '../vault/encoding.ts';

const fromUtf8 = new TextDecoder('utf-8', { fatal: true });

/** A value as UTF-8 JSON bytes. */
export function jsonBytes(value: unknown): Uint8Array {
  return utf8Bytes(JSON.stringify(value));
}

/** UTF-8 JSON bytes back to a value; damaged bytes throw. */
export function parseJsonBytes(bytes: Uint8Array): unknown {
  return JSON.parse(fromUtf8.decode(bytes));
}
