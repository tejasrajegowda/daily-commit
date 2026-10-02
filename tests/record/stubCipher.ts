// A stand-in for the real cipher: the same interface, and it answers just as late, but it keeps
// nothing secret. It lives in tests/ so it can never ship.
import { CipherError, type RowCipher } from '../../src/vault/cipher.ts';
import { fromBase64url, jsonBytes, parseJsonBytes, toBase64url } from '../../src/record/bytes.ts';

/** The stand-in's two key ids: 16 bytes each, base64url, like the real ones. */
export const STUB_KEYS = { r: toBase64url(new Uint8Array(16).fill(0x11)), w: toBase64url(new Uint8Array(16).fill(0x22)) } as const;

/** Resolves on a later turn of the event loop, the way WebCrypto does. */
export const late = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0));

export function stubCipher(keys: { readonly r: string; readonly w: string } = STUB_KEYS): RowCipher {
  return {
    async seal(ctx, plain) {
      await late();
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const ct = jsonBytes({ bound: [ctx.table, ctx.id, ctx.slot], body: toBase64url(plain) });
      return { v: 1, k: keys[ctx.slot], iv: toBase64url(iv), ct: toBase64url(ct) };
    },
    async open(ctx, env) {
      await late();
      if (env.v !== 1) throw new CipherError('newer-app');
      if (env.k !== keys[ctx.slot]) throw new CipherError('other-vault');
      let inner: { bound?: unknown; body?: unknown };
      try { inner = parseJsonBytes(fromBase64url(env.ct)) as typeof inner; } catch { throw new CipherError('damaged'); }
      if (JSON.stringify(inner.bound) !== JSON.stringify([ctx.table, ctx.id, ctx.slot]) || typeof inner.body !== 'string') throw new CipherError('damaged');
      return fromBase64url(inner.body);
    },
  };
}
