// The tags bound into every locked value, naming the table it belongs to. Frozen: a tag never
// changes, even if a table is renamed, or every value already stored would stop opening.

export const TABLE_TAGS = Object.freeze({
  settings: 'set',
  habits: 'hab',
  observations: 'obs',
  days: 'day',
  entries: 'ent',
  notyet: 'nyt',
  cues: 'cue',
  reviews: 'rev',
} as const);

/** The tag bound into every line of the change log. Frozen like the others. */
export const CHANGE_TAG = 'chg';

/** A table that holds locked values. */
export type LockedTable = keyof typeof TABLE_TAGS;
export type TableTag = (typeof TABLE_TAGS)[LockedTable] | typeof CHANGE_TAG;
