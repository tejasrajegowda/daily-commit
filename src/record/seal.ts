import type { LocalDate } from '../rules/types.ts';
import { addDays } from '../rules/dates.ts';

/** What a write puts on a day: a recorded value or words, or only a plan made in advance. */
export type WriteKind = 'value' | 'plan';

/**
 * The seal: which days a write may touch. Today and yesterday stay open; older days are closed for
 * good. A later day takes only a plan, with one exception: a habit asked in the morning, logged
 * between midnight and the boundary, goes to the day ahead (`morningAhead`).
 */
export function isOpen(date: LocalDate, kind: WriteKind, today: LocalDate, morningAhead: boolean): boolean {
  if (date < addDays(today, -1)) return false;
  if (date <= today) return true;
  if (kind === 'plan') return true;
  return morningAhead && date === addDays(today, 1);
}
