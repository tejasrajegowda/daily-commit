// A stand-in for the real whole-file cipher. It keeps nothing secret: its "ciphertext" is the body
// followed by a 16-byte tag (sha256 over the header, the IV and the body), so a change to the
// header or the body is caught, as GCM would catch it. It lives in tests/ so it can never ship.
import { createHash } from 'node:crypto';
import { BackupError, type BackupCipher } from '../../src/vault/cipher.ts';
import { late, stubCipher } from './stubCipher.ts';

/** The stand-in's two secrets. */
export const STUB_SECRETS = { passphrase: 'CANARY-PASS', recovery: 'CANARY-CODE' } as const;

const KNOWN_KDF = ['pbkdf2-sha256', 'hkdf-sha256'];

const tagOf = (header: Uint8Array, iv: Uint8Array, body: Uint8Array): Uint8Array =>
  createHash('sha256').update(header).update(iv).update(body).digest().subarray(0, 16);

const same = (a: Uint8Array, b: Uint8Array): boolean => a.length === b.length && a.every((x, i) => x === b[i]);

export function stubBackup(secrets: { readonly passphrase: string; readonly recovery: string } = STUB_SECRETS): BackupCipher {
  return {
    async sealBody(body, headerBytes, iv) {
      await late();
      const out = new Uint8Array(body.length + 16);
      out.set(body);
      out.set(tagOf(headerBytes, iv, body), body.length);
      return out;
    },
    async openBody(headerBytes, iv, ct, wraps, secret) {
      await late();
      const alg = (wraps[secret.method].kdf as { alg?: unknown }).alg;
      if (typeof alg !== 'string' || !KNOWN_KDF.includes(alg)) throw new BackupError('newer-app');
      if (secret.text !== secrets[secret.method]) throw new BackupError('wrong-secret');
      if (ct.length < 16) throw new BackupError('damaged');
      const body = ct.subarray(0, ct.length - 16);
      if (!same(ct.subarray(ct.length - 16), tagOf(headerBytes, iv, body))) throw new BackupError('damaged');
      return {
        body: body.slice(),
        async openKeys() {},
        async testOpen({ keys }, ctx, env) {
          await stubCipher({ r: keys.r.id, w: keys.w.id }).open(ctx, env);
        },
      };
    },
  };
}
