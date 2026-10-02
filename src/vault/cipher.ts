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
