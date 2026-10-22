// One short line per shipped version, newest first. A version with no line is missing from this
// list, so the checks refuse that update.

export interface Change {
  readonly version: string;
  readonly line: string;
}

export const CHANGES: readonly Change[] = [
  { version: '0.1.0', line: 'The first version on this phone.' },
];

/** Entries from this version down to the oldest. Nothing, if this version has no line. */
export function changesFrom(version: string): readonly Change[] {
  const at = CHANGES.findIndex(change => change.version === version);
  if (at < 0) return [];
  return CHANGES.slice(at);
}
