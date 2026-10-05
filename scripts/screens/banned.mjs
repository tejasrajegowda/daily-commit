// The words the binding wellbeing rules forbid on screen, with the rule each comes from.
// Matched case-insensitively, as whole words.

/** May appear nowhere, in any sense (§8 #1, #37). "100%" is caught by the rule against "%". */
export const NEVER = [
  ['streak', '§8 #1, #37'],
  ['perfect', '§8 #37'],
  ['clean', '§8 #37'],
  ['on track', '§8 #37'],
  ['relapse', '§8 #37'],
];

/** Moral vocabulary (§8 #37): describe, don't evaluate. */
export const MORAL = [
  ['failed', '§8 #37'],
  ['missed', '§8 #37'],
  ['broken', '§8 #37'],
  ['lost', '§8 #37'],
  ['behind', '§8 #37'],
  ['should', '§8 #37'],
  ['ruined', '§8 #37'],
];

/**
 * Sentences where a moral word describes a thing, not a person or a day: each was read and ruled
 * in the ledger. The whole phrase must match, so the same word anywhere else still fails.
 */
export const FACTUAL = [
  'if the paper is lost',
  'if this code and the passphrase are both lost',
];

/** Internal record flags that must never be shown (§8, the backfill and edit marks). */
export const INTERNAL = ['is_backfill', 'edited_after_close', 'reopened_count', 'isBackfill', 'editedAfterClose', 'reopenedCount'];
