import { backupCipher } from './backupCipher.ts';
import { CipherError, type BackupCipher, type OpenFailure, type RowCipher, type Secret } from './cipher.ts';
import type { KekSecret } from './kdf.ts';
import { openKeys, unwrapMaster, wrapMaster, SecretError, type OpenKeys } from './keys.ts';
import type { Random } from './random.ts';
import { newRecoveryCode, readCode } from './recovery.ts';
import { rowCipher } from './rowCipher.ts';
import type { StoredVault, StoredWrap } from './stored.ts';

// What the app asks of the lock: open it, and change what opens it. The raw master key is met
// only inside withRawMasterKey, after typing the passphrase or the recovery code again, and it
// is zero-filled as soon as the job is done. An open vault holds no key that script can read.

/** The vault's plain rows, as the record reads them before unlock. */
export interface VaultRowsIn {
  readonly vault: StoredVault;
  readonly passphrase: StoredWrap;
  readonly recovery: StoredWrap;
}

export type Unopened =
  | { readonly kind: 'WrongSecret' }
  /** needs a newer app · belongs to another vault · damaged */
  | { readonly kind: 'Refused'; readonly reason: OpenFailure };

export type UnlockResult = { readonly kind: 'Unlocked'; readonly keys: OpenKeys } | Unopened;

/** The ciphers a record session runs on, made from an open vault. */
export function sessionCiphers(keys: OpenKeys, random?: Random): { readonly cipher: RowCipher; readonly backup: BackupCipher } {
  return { cipher: rowCipher(keys, random), backup: backupCipher(keys) };
}

/** The master key's raw bytes from what was typed, or why not. The caller zero-fills them. */
async function rawFrom(rows: VaultRowsIn, secret: Secret): Promise<Uint8Array<ArrayBuffer> | Unopened> {
  const wrap = rows[secret.method];
  if (wrap.kid !== rows.vault.kid) return { kind: 'Refused', reason: 'damaged' };
  let kek: KekSecret;
  if (secret.method === 'passphrase') {
    kek = { passphrase: secret.text };
  } else {
    const read = readCode(secret.text);
    if (!read.ok) return { kind: 'WrongSecret' };
    kek = { code: read.bytes };
  }
  try {
    return await unwrapMaster(wrap, kek);
  } catch (e) {
    if (e instanceof SecretError) return { kind: 'WrongSecret' };
    if (e instanceof CipherError) return { kind: 'Refused', reason: e.failure };
    throw e;
  } finally {
    if ('code' in kek) kek.code.fill(0);
  }
}

/** Opens the vault with the passphrase or the recovery code. */
export async function unlockWithSecret(rows: VaultRowsIn, secret: Secret): Promise<UnlockResult> {
  const raw = await rawFrom(rows, secret);
  if (!(raw instanceof Uint8Array)) return raw;
  try {
    return { kind: 'Unlocked', keys: await openKeys(raw, rows.vault) };
  } catch (e) {
    if (e instanceof CipherError) return { kind: 'Refused', reason: e.failure };
    throw e;
  }
}

/**
 * The one way to the raw master key after first run: the passphrase or the recovery code is
 * typed again, the job runs, and the bytes are zero-filled afterwards, whatever happens.
 */
export async function withRawMasterKey<T>(rows: VaultRowsIn, auth: Secret, job: (raw: Uint8Array<ArrayBuffer>) => Promise<T>): Promise<{ readonly kind: 'Done'; readonly value: T } | Unopened> {
  const raw = await rawFrom(rows, auth);
  if (!(raw instanceof Uint8Array)) return raw;
  try {
    return { kind: 'Done', value: await job(raw) };
  } finally {
    raw.fill(0);
  }
}

/** A new passphrase copy, one generation on, checked; the record stores it with replaceWrapper. */
export async function changePassphrase(rows: VaultRowsIn, auth: Secret, next: string, random: Random, now: number) {
  return withRawMasterKey(rows, auth, raw => wrapMaster(raw, 'passphrase', rows.vault.kid, rows.vault.generation + 1, { passphrase: next }, random, now));
}

/**
 * A new recovery code and its copy, one generation on, checked. The code is shown once and typed
 * back before the record stores the copy; the old code stops opening the record from then on.
 */
export async function replaceRecoveryCode(rows: VaultRowsIn, auth: Secret, random: Random, now: number) {
  return withRawMasterKey(rows, auth, async raw => {
    const code = newRecoveryCode(random);
    try {
      return { code: code.text, wrap: await wrapMaster(raw, 'recovery', rows.vault.kid, rows.vault.generation + 1, { code: code.bytes }, random, now) };
    } finally {
      code.bytes.fill(0);
    }
  });
}
