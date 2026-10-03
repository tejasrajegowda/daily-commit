import type { Envelope } from './cipher.ts';
import type { KdfSettings } from './kdf.ts';

// The two plain rows the lock owns, as stored. They are defined here, beside the keys they hold,
// and the record stores them as they are.

/** A portable copy of the master key, wrapped by the passphrase or by the recovery code. */
export interface StoredWrap {
  readonly method: 'passphrase' | 'recovery';
  /** the master key this copy opens */
  readonly kid: string;
  /** the vault's generation when this copy was made */
  readonly generation: number;
  readonly kdf: KdfSettings;
  readonly iv: string;
  /** the 32-byte master key, AES-GCM-locked under the KEK, with its tag */
  readonly ct: string;
  readonly created_at: number;
  readonly updated_at: number;
}

/** The one vault row. That it exists means first run finished. */
export interface StoredVault {
  readonly key: 'main';
  readonly vault_id: string;
  readonly kid: string;
  /** goes up by one each time the passphrase or the recovery code changes */
  readonly generation: number;
  /** the words key and the record key, each with its id, wrapped under the master key */
  readonly keys: {
    readonly w: { readonly id: string; readonly wrap: Envelope };
    readonly r: { readonly id: string; readonly wrap: Envelope };
  };
  readonly created_at: number;
  readonly updated_at: number;
}
