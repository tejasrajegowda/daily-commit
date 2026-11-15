import type { LocalDate } from './types.ts';

// Rest days (§8 #14, as amended by D-24 and D-30..D-31): marked in advance, before their day begins,
// at most two in each calendar month, counted per day by the marked day's month. A whole rest day and
// any one-habit plans made in advance for the same day use one of the two between them. Offered in the
// evening, for tomorrow, and from Plan for any later day. A rest day keeps the day as planned rest, a
// marked square in Look back, never an empty one, and a run carries on through it.

export const REST_DAYS_A_MONTH = 2;

/** Days left in `date`'s calendar month. `used`: the dates that already hold a counted mark. */
export function restDaysLeft(used: Iterable<LocalDate>, date: LocalDate): number {
  const month = date.slice(0, 7);
  const days = new Set<LocalDate>();
  for (const d of used) if (d.slice(0, 7) === month) days.add(d);
  return Math.max(0, REST_DAYS_A_MONTH - days.size);
}

/** Whether a new mark on `date` counts: its day already counts, or its month has one left. */
export function restCounts(used: Iterable<LocalDate>, date: LocalDate): boolean {
  const list = [...used];
  return list.includes(date) || restDaysLeft(list, date) > 0;
}

/**
 * Offered in the evening, for tomorrow, while marking it would count: tomorrow's month has one left,
 * or tomorrow already counts through a plan made for it. Never when tomorrow is a rest day already.
 */
export function restOffered(input: { readonly evening: boolean; readonly left: number; readonly counted: boolean; readonly already: boolean }): boolean {
  return input.evening && (input.left > 0 || input.counted) && !input.already;
}
