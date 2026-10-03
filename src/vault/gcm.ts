// AES-256-GCM, the one cipher the lock uses. The ciphertext always carries its 16-byte tag at the
// end, so a changed byte anywhere, in it or in what it is bound to, fails to open.

export const KEY_BYTES = 32;
export const ID_BYTES = 16;
export const IV_BYTES = 12;
export const TAG_BYTES = 16;

export async function gcmSeal(key: CryptoKey, iv: Uint8Array<ArrayBuffer>, aad: Uint8Array<ArrayBuffer>, plain: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
  return new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad }, key, plain));
}

/** Opens a ciphertext, or resolves to undefined if it doesn't open: wrong key, wrong AAD, or changed bytes. */
export async function gcmOpen(key: CryptoKey, iv: Uint8Array<ArrayBuffer>, aad: Uint8Array<ArrayBuffer>, ct: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer> | undefined> {
  if (iv.length !== IV_BYTES || ct.length < TAG_BYTES) return undefined;
  try {
    return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv, additionalData: aad }, key, ct));
  } catch {
    return undefined;
  }
}

/** Raw bytes as an AES-GCM key that can never be read back out. */
export function importAesKey(raw: Uint8Array<ArrayBuffer>, uses: readonly KeyUsage[]): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, [...uses]);
}

/** Whether two byte strings are the same, compared in full. */
export function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
}
