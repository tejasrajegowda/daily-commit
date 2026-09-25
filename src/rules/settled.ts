import type { Habit, LocalDate, Observation } from './types.ts';
import { addDays, datesFrom } from './dates.ts';
import { doneAndAsked } from './stats.ts';
import { tierOn } from './state.ts';

export const SETTLE_WEEKS = 8;

/**
 * After about eight consistent weeks the app offers to stop asking — it never moves a habit by
 * itself. Consistent means every one of the last eight weeks: done on at least 6 of every 7 days it
 * was asked. Judged week by week, so one hard week is never hidden inside a good average.
 * `lastDay` is the last finished day (yesterday).
 */
export function offersToSettle(habit: Habit, index: ReadonlyMap<string, Observation>, lastDay: LocalDate): boolean {
  if (habit.kind === 'mood' || habit.retiredOn !== undefined) return false;
  const firstDay = addDays(lastDay, -(SETTLE_WEEKS * 7 - 1));
  for (const date of datesFrom(firstDay, lastDay)) if (tierOn(habit, date) !== 'focus') return false;
  for (let w = 0; w < SETTLE_WEEKS; w++) {
    const from = addDays(firstDay, w * 7), to = addDays(from, 6);
    const { done, asked } = doneAndAsked(habit, index, from, to);
    if (asked === 0 || done * 7 < asked * 6) return false;
  }
  return true;
}
