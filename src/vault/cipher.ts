import type { TableTag } from './tags.ts';

/** A locked value as stored: its format version, the id of the key that locked it, the IV and the ciphertext. */
export interface Envelope {
  readonly v: number;
  /** the 16-byte id of the data key, base64url */
  readonly k: string;
  /** 12 fresh random bytes, base64url */
  readonly iv: string;
  /** the ciphertext with its tag, base64url */
  readonly ct: string;
}

/** `r` is locked with the record key, `w` with the words key. */
export type Slot = 'r' | 'w';

/** What a locked value is bound to, so a value moved to another row or slot fails to open. */
export interface EnvelopeContext {
  readonly table: TableTag;
  /** the row's primary key as text; an observation's is `<habit id>|<date>` */
  readonly id: string;
  readonly slot: Slot;
}

/** Why a locked value would not open. Never "wrong passphrase": that is a different question. */
export type OpenFailure = 'newer-app' | 'other-vault' | 'damaged';

export class CipherError extends Error {
  readonly failure: OpenFailure;
  constructor(failure: OpenFailure) {
    super(`a locked value did not open: ${failure}`);
    this.name = 'CipherError';
    this.failure = failure;
  }
}

/**
 * Locks and opens the locked part of a row. Every call is asynchronous, like WebCrypto's, so it is
 * never made inside a storage transaction: the transaction would end before the answer came back.
 */
export interface RowCipher {
  seal(ctx: EnvelopeContext, plain: Uint8Array): Promise<Envelope>;
  open(ctx: EnvelopeContext, env: Envelope): Promise<Uint8Array>;
}

/** Why a backup file would not open. Each one has its own message on the restore screen. */
export type BackupFailure = 'wrong-secret' | 'newer-app' | 'damaged' | 'other-vault';

export class BackupError extends Error {
  readonly reason: BackupFailure;
  constructor(reason: BackupFailure) {
    super(`the backup did not open: ${reason}`);
    this.name = 'BackupError';
    this.reason = reason;
  }
}

/** What was typed to open a backup: the passphrase, or the recovery code from paper. */
export interface Secret {
  readonly method: 'passphrase' | 'recovery';
  readonly text: string;
}

/** A portable copy of the master key as a backup's header carries it: a `wrappers` row, as stored. */
export interface PortableWrap {
  readonly method: 'passphrase' | 'recovery';
  readonly kid: string;
  readonly generation: number;
  readonly kdf: object;
  readonly iv: string;
  readonly ct: string;
}

/** The words key and the record key, each wrapped under the master key, as a `vault` row holds them. */
export interface DataKeyWraps {
  readonly w: { readonly id: string; readonly wrap: Envelope };
  readonly r: { readonly id: string; readonly wrap: Envelope };
}

/** A vault's key id with its wrapped words and record keys: what opening W and R needs. */
export interface VaultKeyWraps {
  readonly kid: string;
  readonly keys: DataKeyWraps;
}

/** A backup body that opened. */
export interface OpenedBackup {
  /** the body exactly as it was sealed */
  readonly body: Uint8Array;
  /**
   * Checks that the backup's words and record keys open under its master key, naming its own
   * vault, as unlock will open them. Resolves, or rejects with a CipherError.
   */
  openKeys(vault: VaultKeyWraps): Promise<void>;
  /**
   * Checks that one locked value from the backup opens under the backup's own keys. It says
   * nothing about what is inside: it resolves, or rejects with a CipherError.
   */
  testOpen(vault: VaultKeyWraps, ctx: EnvelopeContext, env: Envelope): Promise<void>;
}

/**
 * Locks and opens a whole backup's body. Sealing needs the backup key, held only while unlocked.
 * Opening needs only the passphrase or the recovery code, so it works on a phone never set up.
 */
export interface BackupCipher {
  /** the body's ciphertext with its 16-byte tag; the header bytes are bound in, so changing either fails */
  sealBody(body: Uint8Array, headerBytes: Uint8Array, iv: Uint8Array): Promise<Uint8Array>;
  /** opens the body with the secret, or rejects with a BackupError */
  openBody(
    headerBytes: Uint8Array,
    iv: Uint8Array,
    ct: Uint8Array,
    wraps: { readonly passphrase: PortableWrap; readonly recovery: PortableWrap },
    secret: Secret,
  ): Promise<OpenedBackup>;
}
