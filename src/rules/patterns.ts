import type { Habit, HabitKind, LocalDate, Observation } from './types.ts';
import { datesFrom } from './dates.ts';
import { lookup, stateOf } from './state.ts';

// "What seems to go well together", inside the monthly review only.
// Positive associations only, at least eight days on each side, nothing before day 60, and never a
// coefficient: the result is two plain averages in the habit's own unit, for the screen to say in words.

export const PATTERNS_FROM_DAY = 60;
export const MIN_DAYS_EACH_SIDE = 8;

/** Smallest difference worth mentioning, in each kind's own unit. */
const MIN_DIFFERENCE: Record<HabitKind, number> = { time: 5, min: 10, count: 1, tri: 0.1, mood: 0.25 };

export interface Pairing {
  /** the habit whose done days are compared with its other days */
  readonly when: string;
  /** the habit whose outcome is compared */
  readonly then: string;
}

export interface Together {
  readonly when: string;
  readonly then: string;
  readonly withDays: number;
  readonly withoutDays: number;
  /** average outcome on the days `when` was done, in the unit of `then` */
  readonly withValue: number;
  /** average outcome on its other days */
  readonly withoutValue: number;
}

/**
 * The outcome of a habit on one day, or null when there is nothing to compare. An answered
 * "not today" and a day never answered give the same outcome, so answering honestly never
 * changes what this finds.
 */
function outcome(habit: Habit, obs: Observation | undefined, date: LocalDate): number | null {
  const s = stateOf(habit, obs, date);
  if (s === 'off' || s === 'outside' || s === 'planned') return null;
  const v = obs?.value;
  switch (habit.kind) {
    case 'tri': return s === 'did' ? 1 : s === 'partly' ? 0.5 : 0;
    case 'min':
    case 'count': return typeof v === 'number' && v > 0 ? v : 0;
    case 'time':
    case 'mood': return typeof v === 'number' ? v : null;
  }
}

/** Earlier is better for a clock time; more is better for everything else. */
const better = (kind: HabitKind, a: number, b: number): boolean =>
  kind === 'time' ? b - a >= MIN_DIFFERENCE.time : a - b >= MIN_DIFFERENCE[kind];

const mean = (xs: readonly number[]): number => xs.reduce((s, x) => s + x, 0) / xs.length;

export function goesWellTogether(
  habits: readonly Habit[],
  index: ReadonlyMap<string, Observation>,
  pairs: readonly Pairing[],
  from: LocalDate,
  to: LocalDate,
  journeyDay: number,
): Together[] {
  if (journeyDay < PATTERNS_FROM_DAY) return [];
  const byId = new Map(habits.map(h => [h.id, h]));
  const found: Together[] = [];
  for (const p of pairs) {
    const when = byId.get(p.when), then = byId.get(p.then);
    if (!when || !then || when.id === then.id || when.kind === 'mood') continue;
    const withV: number[] = [], withoutV: number[] = [];
    for (const date of datesFrom(from, to)) {
      const s = stateOf(when, lookup(index, when.id, date), date);
      if (s === 'off' || s === 'outside' || s === 'planned') continue;
      const o = outcome(then, lookup(index, then.id, date), date);
      if (o === null) continue;
      (s === 'did' ? withV : withoutV).push(o);
    }
    if (withV.length < MIN_DAYS_EACH_SIDE || withoutV.length < MIN_DAYS_EACH_SIDE) continue;
    const a = mean(withV), b = mean(withoutV);
    if (!better(then.kind, a, b)) continue;
    found.push({ when: when.id, then: then.id, withDays: withV.length, withoutDays: withoutV.length, withValue: a, withoutValue: b });
  }
  return found;
}
