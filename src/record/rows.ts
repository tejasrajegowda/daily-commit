import type { Envelope } from '../vault/cipher.ts';

// The rows as stored. Only ids, dates and change stamps are plain; everything else is inside the
// locked values `r` (under the record key) and `w` (under the words key). A deleted row is a
// tombstone: it keeps its key, its other plain fields and its stamps, and has no `r` or `w`.

/** The change stamps every synced row carries, in plain. */
export interface Stamps {
  readonly updated_at: number;
  /** the device that made the change */
  readonly updated_by: string;
  /** set when the row became a tombstone */
  readonly deleted_at?: number;
}

export interface Locked {
  readonly r?: Envelope;
  readonly w?: Envelope;
}

export interface SettingRow extends Stamps, Locked { readonly key: string }
export interface HabitRow extends Stamps, Locked { readonly id: string }
export interface ObservationRow extends Stamps, Locked { readonly habit_id: string; readonly local_date: string }
export interface DayRow extends Stamps, Locked { readonly local_date: string }
export interface EntryRow extends Stamps, Locked { readonly id: string; readonly local_date: string }
export interface NotYetRow extends Stamps, Locked { readonly id: string }
export interface CueRow extends Stamps, Locked { readonly id: string }
export interface ReviewRow extends Stamps, Locked { readonly key: string; readonly period_start: string; readonly period_end: string }

/** How a key-wrapping key is derived; kept with the wrap so it can be opened again later. */
export type Kdf =
  | { readonly alg: 'pbkdf2-sha256'; readonly iterations: number; readonly salt: string; readonly norm: 'utf8-nfc-trim-v1' }
  | { readonly alg: 'hkdf-sha256'; readonly salt: string; readonly info: 'dc/recovery/v1' };

/** A portable copy of the master key, wrapped by the passphrase or by the recovery code. */
export interface WrapperRow {
  readonly method: 'passphrase' | 'recovery';
  readonly kid: string;
  readonly generation: number;
  readonly kdf: Kdf;
  readonly iv: string;
  readonly ct: string;
  readonly created_at: number;
  readonly updated_at: number;
}

/** The one vault row. That it exists means first run finished. */
export interface VaultRow {
  readonly key: 'main';
  readonly vault_id: string;
  readonly kid: string;
  readonly generation: number;
  readonly keys: {
    readonly w: { readonly id: string; readonly wrap: Envelope };
    readonly r: { readonly id: string; readonly wrap: Envelope };
  };
  readonly created_at: number;
  readonly updated_at: number;
}

/** This device's own plain values; never exported, never synced. */
export interface DeviceRow {
  readonly key: string;
  readonly value: string | number | boolean;
}

/** How far a change to locked values has got, so it can carry on after a stop. */
export interface MigrationRow {
  readonly id: string;
  readonly done_at?: number;
  readonly cursor?: string;
}
