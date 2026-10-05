import { TABLE_TAGS, type LockedTable } from '../vault/tags.ts';
import { CipherError, type Envelope, type RowCipher, type Slot } from '../vault/cipher.ts';
import { jsonBytes, parseJsonBytes } from './bytes.ts';

// What is plain and what is locked, table by table, and the one way a row's locked values are made
// and opened. A field is plain only if storage must index it, sync must merge on it, or the lock
// screen needs it.

/** The version of every locked value's inner shape; a later schema bumps it. */
export const PAYLOAD_VERSION = 1;

/** Each table's plain key fields, in primary-key order. */
export const KEY_FIELDS: Readonly<Record<LockedTable, readonly string[]>> = {
  settings: ['key'],
  habits: ['id'],
  observations: ['habit_id', 'local_date'],
  days: ['local_date'],
  entries: ['id'],
  notyet: ['id'],
  cues: ['id'],
  reviews: ['key'],
};

/** Each table's other plain fields, besides its key and the change stamps. */
export const OTHER_PLAIN: Readonly<Record<LockedTable, readonly string[]>> = {
  settings: [], habits: [], observations: [], days: [], entries: ['local_date'], notyet: [], cues: [], reviews: ['period_start', 'period_end'],
};

/** The change stamps, plain on every synced row. */
export const STAMP_FIELDS = ['updated_at', 'updated_by', 'deleted_at'] as const;

/** Which fields each table locks, and under which key: `r` the record, `w` the words. */
export const LOCKED: Readonly<Record<LockedTable, { readonly r: readonly string[]; readonly w: readonly string[] }>> = {
  settings: { r: ['value'], w: ['value'] },     // the contact and the bad-night note under w, every other setting under r
  habits: { r: ['name', 'sub', 'kind', 'periods', 'tiers', 'schedule', 'target', 'order', 'settled_at', 'replaces'], w: [] },
  observations: { r: ['kind', 'value', 'planned', 'logged_at', 'is_backfill', 'edited_after_close'], w: [] },
  days: { r: ['closed_at', 'lights_out', 'rest_day', 'reopened_count'], w: ['intent', 'remark', 'bad_night_note'] },
  entries: { r: [], w: ['body', 'trashed_at'] },
  notyet: { r: [], w: ['text', 'why', 'started_at', 'trashed_at'] },
  cues: { r: ['habit_id', 'kind', 'times', 'fade', 'enabled', 'private', 'created_on', 'text'], w: ['text'] },   // a private reminder's text under w
  reviews: { r: [], w: ['answers', 'closed_at'] },
};

export type Fields = Readonly<Record<string, unknown>>;
export type Plain = Readonly<Record<string, string>>;

/** A record split for storage: its plain fields, and the fields each locked slot will hold. */
export interface Parts {
  readonly plain: Plain;
  readonly r?: Fields;
  readonly w?: Fields;
}

/** What opening a row's slots gives back. */
export interface Opened {
  readonly r?: Fields;
  readonly w?: Fields;
}

/** The locked part of a stored row. */
export interface LockedSlots {
  r?: Envelope;
  w?: Envelope;
}

/** The text a row's locked values are bound to: its primary key; an observation's is `<habit id>|<date>`. */
export function rowId(table: LockedTable, plain: Plain): string {
  return KEY_FIELDS[table].map(field => {
    const value = plain[field];
    if (value === undefined || value === '') throw new Error(`${table} row has no ${field}`);
    return value;
  }).join('|');
}

/** Locks a record's slots, one envelope each. Called before a transaction opens, never inside one. */
export async function sealParts(cipher: RowCipher, table: LockedTable, parts: Parts): Promise<LockedSlots> {
  const id = rowId(table, parts.plain);
  const lock = (slot: Slot, fields: Fields | undefined) => fields === undefined
    ? undefined
    : cipher.seal({ table: TABLE_TAGS[table], id, slot }, jsonBytes({ ...fields, pv: PAYLOAD_VERSION }));
  const [r, w] = await Promise.all([lock('r', parts.r), lock('w', parts.w)]);
  const slots: LockedSlots = {};
  if (r) slots.r = r;
  if (w) slots.w = w;
  return slots;
}

/** Opens a stored row's slots back into fields. A value written by a newer app refuses to open. */
export async function openParts(cipher: RowCipher, table: LockedTable, plain: Plain, slots: LockedSlots): Promise<Opened> {
  const id = rowId(table, plain);
  const unlock = async (slot: Slot, env: Envelope | undefined): Promise<Fields | undefined> => {
    if (env === undefined) return undefined;
    const fields = parseJsonBytes(await cipher.open({ table: TABLE_TAGS[table], id, slot }, env)) as Fields;
    if (typeof fields.pv !== 'number' || fields.pv > PAYLOAD_VERSION) throw new CipherError('newer-app');
    return fields;
  };
  const [r, w] = await Promise.all([unlock('r', slots.r), unlock('w', slots.w)]);
  return { ...(r && { r }), ...(w && { w }) };
}

/** A stored row's plain fields, as text. */
export function plainOf(table: LockedTable, row: Readonly<Record<string, unknown>>): Plain {
  const out: Record<string, string> = {};
  for (const field of [...KEY_FIELDS[table], ...OTHER_PLAIN[table]]) {
    const value = row[field];
    if (typeof value === 'string') out[field] = value;
  }
  return out;
}
