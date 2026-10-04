import type { LocalDate } from './types.ts';
import { dayNumber } from './journey.ts';

// Rest days (§8 #14): two in each calendar month, from day 14 of the journey, offered in the evening
// only while something in Focus is still unanswered. A rest day keeps the day as planned rest, a
// marked square in Look back, never an empty one.

export const REST_DAYS_A_MONTH = 2;
export const REST_FROM_DAY = 14;

/** Rest days left in `today`'s calendar month: two a month, none before day 14. */
export function restDaysLeft(restDays: Iterable<LocalDate>, today: LocalDate, journeyStart: LocalDate): number {
  if (dayNumber(journeyStart, today) < REST_FROM_DAY) return 0;
  const month = today.slice(0, 7);
  let used = 0;
  for (const d of restDays) if (d.slice(0, 7) === month) used++;
  return Math.max(0, REST_DAYS_A_MONTH - used);
}

/** Offered in the evening only, while some Focus habit asked today is still unanswered, and one is left. */
export function restOffered(input: { readonly evening: boolean; readonly openFocus: number; readonly left: number }): boolean {
  return input.evening && input.openFocus > 0 && input.left > 0;
}
