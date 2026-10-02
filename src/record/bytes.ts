// Bytes as text and text as bytes. base64url is how every binary value is stored, in the database
// and inside a backup alike.

const utf8 = new TextEncoder();
const fromUtf8 = new TextDecoder('utf-8', { fatal: true });

export function toBase64url(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromBase64url(text: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/.test(text) || text.length % 4 === 1) throw new Error('not base64url');
  const s = atob(text.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (text.length % 4)) % 4));
  return Uint8Array.from(s, c => c.charCodeAt(0));
}

/** A value as UTF-8 JSON bytes. */
export function jsonBytes(value: unknown): Uint8Array {
  return utf8.encode(JSON.stringify(value));
}

/** UTF-8 JSON bytes back to a value; damaged bytes throw. */
export function parseJsonBytes(bytes: Uint8Array): unknown {
  return JSON.parse(fromUtf8.decode(bytes));
}
