import type { Habit, LocalDate, Observation } from './types.ts';
import { datesFrom } from './dates.ts';
import { lookup, stateOf } from './state.ts';

export interface HabitNumbers {
  /** days it was done, all time — can only go up */
  readonly did: number;
  /** minutes recorded in total (minutes habits) — can only go up */
  readonly minutes: number;
  /** the longest run ever — can only go up */
  readonly longestRun: number;
  /** the run in progress — the one number here allowed to go back to zero; never a headline */
  readonly currentRun: number;
  /** times a single quiet day was followed by a done day */
  readonly cameBack: number;
  /** single quiet days after it had been done at least once */
  readonly gaps: number;
}

/**
 * Lifetime numbers for one habit from `from` to `today`.
 *
 * Runs follow the rule that a run only ends after two quiet days in a row, never one:
 * - "did" extends the run;
 * - "partly" keeps it alive but does not lengthen it (it is not a miss);
 * - "planned", "off" and "outside" days are skipped entirely;
 * - `today` counts only once it is answered — an unfinished day is never held against a run.
 */
export function habitNumbers(
  habit: Habit,
  index: ReadonlyMap<string, Observation>,
  from: LocalDate,
  today: LocalDate,
): HabitNumbers {
  let did = 0, minutes = 0, run = 0, longest = 0, quiet = 0, gaps = 0, cameBack = 0;
  let seenDid = false, pendingGap = false;
  for (const date of datesFrom(from, today)) {
    const obs = lookup(index, habit.id, date);
    const s = stateOf(habit, obs, date);
    if (s === 'off' || s === 'outside' || s === 'planned') continue;
    if (habit.kind === 'min' && typeof obs?.value === 'number' && obs.value > 0) minutes += obs.value;
    if (s === 'did') {
      did++; run++; quiet = 0; seenDid = true;
      if (run > longest) longest = run;
      if (pendingGap) { cameBack++; pendingGap = false; }
    } else if (s === 'partly') {
      quiet = 0; pendingGap = false;
    } else {
      if (date === today) continue;                 // today is not over yet
      quiet++;
      if (quiet === 1 && seenDid) { gaps++; pendingGap = true; }
      if (quiet >= 2) { run = 0; pendingGap = false; }
    }
  }
  return { did, minutes, longestRun: longest, currentRun: run, cameBack, gaps };
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
