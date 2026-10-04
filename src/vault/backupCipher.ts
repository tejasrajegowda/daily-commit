import { BackupError, CipherError, type BackupCipher, type VaultKeyWraps } from './cipher.ts';
import { gcmOpen, gcmSeal } from './gcm.ts';
import { checkKdf, type KekSecret } from './kdf.ts';
import { deriveBackupKey, importMaster, openDataKeys, unwrapMaster, SecretError, type DataKeys, type OpenKeys } from './keys.ts';
import { readCode } from './recovery.ts';
import { rowCipher } from './rowCipher.ts';

// The real lock on a whole backup file. Its body is locked with the backup key and bound to the
// file's header bytes. Opening needs only the passphrase or the recovery code and the copies of
// the master key in the header, so it works on a phone never set up.

/**
 * A backup cipher. Given the open vault's keys it can seal and open; without them (restore on a
 * phone never set up) it can only open.
 */
export function backupCipher(keys?: Pick<OpenKeys, 'backup'>): BackupCipher {
  return {
    async sealBody(body, headerBytes, iv) {
      if (!keys) throw new Error('this backup cipher only opens: it has no backup key');
      return gcmSeal(keys.backup, new Uint8Array(iv), new Uint8Array(headerBytes), new Uint8Array(body));
    },

    async openBody(headerBytes, iv, ct, wraps, secret) {
      const wrap = wraps[secret.method];
      const verdict = checkKdf(wrap.kdf);
      if (verdict !== 'ok') throw new BackupError(verdict);
      let kekSecret: KekSecret;
      if (secret.method === 'passphrase') {
        kekSecret = { passphrase: secret.text };
      } else {
        const read = readCode(secret.text);
        if (!read.ok) throw new BackupError('wrong-secret');
        kekSecret = { code: read.bytes };
      }
      let raw: Uint8Array<ArrayBuffer>;
      try {
        raw = await unwrapMaster(wrap, kekSecret);
      } catch (e) {
        if (e instanceof SecretError) throw new BackupError('wrong-secret');
        if (e instanceof CipherError) throw new BackupError(e.failure === 'newer-app' ? 'newer-app' : 'damaged');
        throw e;
      } finally {
        if ('code' in kekSecret) kekSecret.code.fill(0);
      }
      const { master, base } = await importMaster(raw);
      const body = await gcmOpen(await deriveBackupKey(base), new Uint8Array(iv), new Uint8Array(headerBytes), new Uint8Array(ct));
      if (!body) throw new BackupError('damaged');
      // W and R are opened once per set of wraps, not once per value: a backup holds thousands
      const opened = new Map<VaultKeyWraps, Promise<DataKeys>>();
      // under the vault's own key id, never the one a wrap names: a wrap naming another is refused
      const keysOf = (vault: VaultKeyWraps) => {
        let data = opened.get(vault);
        if (!data) {
          data = openDataKeys(master, vault);
          opened.set(vault, data);
        }
        return data;
      };
      return {
        body,
        async openKeys(vault) {
          await keysOf(vault);
        },
        async testOpen(vault, ctx, env) {
          (await rowCipher(await keysOf(vault)).open(ctx, env)).fill(0);
        },
      };
    },
  };
}
