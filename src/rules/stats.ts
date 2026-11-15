import type { Habit, LocalDate, Observation } from './types.ts';
import { datesFrom, isSealed } from './dates.ts';
import { lookup, stateOf } from './state.ts';

/** "Partly" is an answer, not a skip: it keeps a run alive without lengthening it (D-32). */
export const PARTLY_KEEPS_RUN = true;

export interface HabitNumbers {
  /** days it was done, all time — can only go up */
  readonly did: number;
  /** minutes recorded in total (minutes habits) — can only go up */
  readonly minutes: number;
  /** the longest run ever — can only go up */
  readonly longestRun: number;
  /** the run in progress — the one number here allowed to go back to zero; never a headline */
  readonly currentRun: number;
  /** times a single quiet day was followed by a done day, both days sealed */
  readonly cameBack: number;
}

/**
 * Lifetime numbers for one habit from `from` to `today`.
 *
 * A run follows the owner's rule (D-24):
 * - "did" lengthens it; "partly" keeps it alive without lengthening it;
 * - "off" and "outside" days, and plans that keep the run (marked in advance, within the month's
 *   two), are skipped;
 * - a quiet day (not today, never answered, or a plan that doesn't keep the run) ends it once the day
 *   has sealed. "Not today" and never answered are always treated the same;
 * - today is never held against a run, and a quiet yesterday holds it: the run stays alive, but
 *   nothing after that day lengthens it until the day is filled in or seals.
 *
 * The longest run reads a quiet open day as an end. So a day sealing can never split a run already
 * counted, and the longest run never goes down while the record stays as it is.
 */
export function habitNumbers(
  habit: Habit,
  index: ReadonlyMap<string, Observation>,
  from: LocalDate,
  today: LocalDate,
): HabitNumbers {
  let did = 0, minutes = 0, run = 0, seg = 0, longest = 0, cameBack = 0;
  let held = false, seenDid = false, quiet = 0, pendingGap = false;
  for (const date of datesFrom(from, today)) {
    const obs = lookup(index, habit.id, date);
    const s = stateOf(habit, obs, date);
    if (s === 'off' || s === 'outside') continue;
    if (s === 'planned' && obs?.keepsRun === true) continue;
    if (habit.kind === 'min' && typeof obs?.value === 'number' && obs.value > 0) minutes += obs.value;
    const sealed = isSealed(date, today);
    if (s === 'did') {
      did++; seg++; seenDid = true;
      if (seg > longest) longest = seg;
      if (!held) run++;
      if (sealed && pendingGap) cameBack++;
      quiet = 0; pendingGap = false;
    } else if (s === 'partly' && PARTLY_KEEPS_RUN) {
      quiet = 0; pendingGap = false;
    } else {
      if (date === today) continue;                 // today is not over yet
      seg = 0;
      if (!sealed) { held = true; continue; }       // yesterday: held until it is filled in or seals
      run = 0;
      quiet++;
      pendingGap = quiet === 1 && seenDid;
    }
  }
  return { did, minutes, longestRun: longest, currentRun: run, cameBack };
}

/** Days it was done and days it was asked, between two dates — the inputs to the week's words. */
export function doneAndAsked(
  habit: Habit,
  index: ReadonlyMap<string, Observation>,
  from: LocalDate,
  to: LocalDate,
): { done: number; asked: number } {
  let done = 0, asked = 0;
  for (const date of datesFrom(from, to)) {
    const s = stateOf(habit, lookup(index, habit.id, date), date);
    if (s === 'off' || s === 'outside' || s === 'planned') continue;
    asked++;
    if (s === 'did') done++;
  }
  return { done, asked };
}
