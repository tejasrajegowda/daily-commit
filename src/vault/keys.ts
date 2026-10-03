import { dkAad, wrapAad } from './aad.ts';
import { CipherError, type Envelope, type PortableWrap } from './cipher.ts';
import { fromBase64url, toBase64url, utf8Bytes } from './encoding.ts';
import { gcmOpen, gcmSeal, importAesKey, sameBytes, ID_BYTES, IV_BYTES, KEY_BYTES } from './gcm.ts';
import { deriveKek, newPassphraseKdf, newRecoveryKdf, type KekSecret } from './kdf.ts';
import type { Random } from './random.ts';
import { newRecoveryCode } from './recovery.ts';
import type { StoredVault, StoredWrap } from './stored.ts';

// The key hierarchy. One master key, made at first run, is wrapped by the passphrase and by the
// recovery code. It wraps the words key (W) and the record key (R), and the backup key is derived
// from it. Once a vault is open only W, R and the backup key are held, none of them readable by
// script; the master key's raw bytes are zero-filled as soon as they have been imported.

/** The version of every envelope this app makes. */
export const ENVELOPE_V = 1;
export const BACKUP_INFO = 'dc/backup/v1';

/** A data key while the vault is open: its id, and the key itself, which can't be read back out. */
export interface DataKey {
  readonly id: string;
  readonly key: CryptoKey;
}

export interface DataKeys {
  readonly w: DataKey;
  readonly r: DataKey;
}

/** Everything an open vault holds. */
export interface OpenKeys extends DataKeys {
  readonly kid: string;
  /** locks and opens whole backup files */
  readonly backup: CryptoKey;
}

/** The passphrase or the recovery code did not open the copy it was tried on. */
export class SecretError extends Error {
  constructor() {
    super('the passphrase or recovery code did not open the vault');
    this.name = 'SecretError';
  }
}

function stored(text: string): Uint8Array<ArrayBuffer> {
  try {
    return fromBase64url(text);
  } catch {
    throw new CipherError('damaged');
  }
}

/**
 * Opens a portable copy of the master key with what was typed, and returns its raw bytes; the
 * caller zero-fills them. Rejects with SecretError if the secret doesn't open it, or with a
 * CipherError if its settings are damaged or need a newer app.
 */
export async function unwrapMaster(wrap: Pick<PortableWrap, 'method' | 'kid' | 'kdf' | 'iv' | 'ct'>, secret: KekSecret): Promise<Uint8Array<ArrayBuffer>> {
  const kek = await deriveKek(wrap.kdf, secret);
  const raw = await gcmOpen(kek, stored(wrap.iv), wrapAad(wrap.method, wrap.kid, wrap.kdf), stored(wrap.ct));
  if (!raw) throw new SecretError();
  if (raw.length !== KEY_BYTES) {
    raw.fill(0);
    throw new CipherError('damaged');
  }
  return raw;
}

/**
 * A new portable copy of the master key for one method, with fresh KDF settings. The copy is
 * opened again and compared byte for byte with the key before it is returned, so a copy that
 * wouldn't open is never stored.
 */
export async function wrapMaster(
  raw: Uint8Array<ArrayBuffer>, method: 'passphrase' | 'recovery', kid: string, generation: number,
  secret: KekSecret, random: Random, now: number,
): Promise<StoredWrap> {
  const kdf = method === 'passphrase' ? newPassphraseKdf(random) : newRecoveryKdf(random);
  const kek = await deriveKek(kdf, secret);
  const iv = random(IV_BYTES);
  const aad = wrapAad(method, kid, kdf);
  const ct = await gcmSeal(kek, iv, aad, raw);
  const back = await gcmOpen(kek, iv, aad, ct);
  const same = back !== undefined && sameBytes(back, raw);
  back?.fill(0);
  if (!same) throw new Error('a new copy of the master key did not open to the same key');
  return { method, kid, generation, kdf, iv: toBase64url(iv), ct: toBase64url(ct), created_at: now, updated_at: now };
}

/** The master key, imported twice: to open W and R, and to derive the backup key. The raw bytes are zero-filled. */
export async function importMaster(raw: Uint8Array<ArrayBuffer>): Promise<{ readonly master: CryptoKey; readonly base: CryptoKey }> {
  try {
    const master = await importAesKey(raw, ['unwrapKey']);
    const base = await crypto.subtle.importKey('raw', raw, 'HKDF', false, ['deriveKey']);
    return { master, base };
  } finally {
    raw.fill(0);
  }
}

async function openDataKey(master: CryptoKey, kid: string, id: string, wrap: Envelope): Promise<DataKey> {
  if (typeof wrap.v !== 'number' || wrap.v < ENVELOPE_V || !Number.isInteger(wrap.v)) throw new CipherError('damaged');
  if (wrap.v > ENVELOPE_V) throw new CipherError('newer-app');
  if (wrap.k !== kid) throw new CipherError('other-vault');
  const iv = stored(wrap.iv), ct = stored(wrap.ct);
  try {
    const key = await crypto.subtle.unwrapKey('raw', ct, master, { name: 'AES-GCM', iv, additionalData: dkAad(wrap.v, id, kid) },
      'AES-GCM', false, ['encrypt', 'decrypt']);
    return { id, key };
  } catch {
    throw new CipherError('damaged');
  }
}

/** Opens W and R from their wraps in the vault row. A master key from another vault fails as damaged. */
export async function openDataKeys(master: CryptoKey, vault: Pick<StoredVault, 'kid' | 'keys'>): Promise<DataKeys> {
  const [w, r] = await Promise.all([
    openDataKey(master, vault.kid, vault.keys.w.id, vault.keys.w.wrap),
    openDataKey(master, vault.kid, vault.keys.r.id, vault.keys.r.wrap),
  ]);
  return { w, r };
}

/** The backup key: HKDF-SHA256 over the master key, empty salt, info dc/backup/v1. */
export function deriveBackupKey(base: CryptoKey): Promise<CryptoKey> {
  return crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: utf8Bytes(BACKUP_INFO) },
    base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

/** Opens a vault from the master key's raw bytes, which are zero-filled. */
export async function openKeys(raw: Uint8Array<ArrayBuffer>, vault: Pick<StoredVault, 'kid' | 'keys'>): Promise<OpenKeys> {
  const { master, base } = await importMaster(raw);
  const [data, backup] = await Promise.all([openDataKeys(master, vault), deriveBackupKey(base)]);
  return { kid: vault.kid, ...data, backup };
}

/** A new vault, as first run stores it. */
export interface NewVault {
  readonly vault: StoredVault;
  /** the passphrase copy, then the recovery-code copy */
  readonly wrappers: readonly [StoredWrap, StoredWrap];
  /** shown once, and typed back before first run is stored; kept nowhere */
  readonly recoveryCode: string;
  /** the vault, open */
  readonly keys: OpenKeys;
}

/**
 * Makes a vault: the master key, W and R and their ids, the vault id, a recovery code, and both
 * portable copies. It is then opened back through its own stored wraps, so first run can never
 * store a vault that doesn't open. Every raw key is zero-filled before it returns. The random
 * source is drawn in a fixed order, so a fixed source gives a fixed vault.
 */
export async function createVault(passphrase: string, random: Random, now: number): Promise<NewVault> {
  const master = random(KEY_BYTES), w = random(KEY_BYTES), r = random(KEY_BYTES);
  const kid = toBase64url(random(ID_BYTES)), vaultId = toBase64url(random(ID_BYTES));
  const wId = toBase64url(random(ID_BYTES)), rId = toBase64url(random(ID_BYTES));
  const code = newRecoveryCode(random);
  try {
    const sealer = await importAesKey(master, ['encrypt']);
    const dataKeyWrap = async (id: string, key: Uint8Array<ArrayBuffer>) => {
      const iv = random(IV_BYTES);
      const ct = await gcmSeal(sealer, iv, dkAad(ENVELOPE_V, id, kid), key);
      return { id, wrap: { v: ENVELOPE_V, k: kid, iv: toBase64url(iv), ct: toBase64url(ct) } };
    };
    const keys = { w: await dataKeyWrap(wId, w), r: await dataKeyWrap(rId, r) };
    const vault: StoredVault = { key: 'main', vault_id: vaultId, kid, generation: 1, keys, created_at: now, updated_at: now };
    const wrappers = [
      await wrapMaster(master, 'passphrase', kid, 1, { passphrase }, random, now),
      await wrapMaster(master, 'recovery', kid, 1, { code: code.bytes }, random, now),
    ] as const;
    return { vault, wrappers, recoveryCode: code.text, keys: await openKeys(master.slice(), vault) };
  } finally {
    for (const bytes of [master, w, r, code.bytes]) bytes.fill(0);
  }
}
