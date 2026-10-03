import { envAad } from './aad.ts';
import { CipherError, type RowCipher } from './cipher.ts';
import { fromBase64url, toBase64url } from './encoding.ts';
import { gcmOpen, gcmSeal, IV_BYTES } from './gcm.ts';
import { ENVELOPE_V, type DataKeys } from './keys.ts';
import { systemRandom, type Random } from './random.ts';

// The real lock on a row's values. `r` is locked with the record key and `w` with the words key,
// each with 12 fresh random bytes as its IV on every call, and bound to its table, its row and
// its slot, so a value moved anywhere else, or changed by one byte, refuses to open.

function stored(text: string): Uint8Array<ArrayBuffer> {
  try {
    return fromBase64url(text);
  } catch {
    throw new CipherError('damaged');
  }
}

export function rowCipher(keys: DataKeys, random: Random = systemRandom): RowCipher {
  const ours = new Set([keys.w.id, keys.r.id]);
  return {
    async seal(ctx, plain) {
      const { id, key } = keys[ctx.slot];
      const iv = random(IV_BYTES);
      const ct = await gcmSeal(key, iv, envAad(ENVELOPE_V, id, ctx), new Uint8Array(plain));
      return { v: ENVELOPE_V, k: id, iv: toBase64url(iv), ct: toBase64url(ct) };
    },
    async open(ctx, env) {
      if (typeof env.v !== 'number' || !Number.isInteger(env.v) || env.v < ENVELOPE_V) throw new CipherError('damaged');
      if (env.v > ENVELOPE_V) throw new CipherError('newer-app');
      const { id, key } = keys[ctx.slot];
      // this vault's other key means the value was moved between slots; any other key is another vault's
      if (env.k !== id) throw new CipherError(ours.has(env.k) ? 'damaged' : 'other-vault');
      const plain = await gcmOpen(key, stored(env.iv), envAad(env.v, env.k, ctx), stored(env.ct));
      if (!plain) throw new CipherError('damaged');
      return plain;
    },
  };
}
