// Bytes as text and text as bytes. base64url is how every binary value is stored, in the database
// and inside a backup alike. It lives here, below the record, because the lock needs it too.

const utf8 = new TextEncoder();

export function toBase64url(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromBase64url(text: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]*$/.test(text) || text.length % 4 === 1) throw new Error('not base64url');
  const s = atob(text.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (text.length % 4)) % 4));
  return Uint8Array.from(s, c => c.charCodeAt(0));
}

/** Text as UTF-8 bytes. */
export function utf8Bytes(text: string): Uint8Array<ArrayBuffer> {
  return utf8.encode(text);
}
