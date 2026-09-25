import type { DayState, Habit, LocalDate, Observation, Tier } from './types.ts';
import { weekdayOf } from './dates.ts';

/** Whether the habit is asked on this day at all. */
export function isAsked(habit: Habit, date: LocalDate): boolean {
  if (date < habit.createdOn) return false;
  if (habit.retiredOn !== undefined && date >= habit.retiredOn) return false;
  return habit.days.includes(weekdayOf(date));
}

/** The tier the habit was in on a given day, or null before it existed. */
export function tierOn(habit: Habit, date: LocalDate): Tier | null {
  let tier: Tier | null = null;
  for (const p of habit.tierHistory) if (p.from <= date) tier = p.tier;
  return tier;
}

/**
 * What a habit was on one day. The raw value is judged against the current target here, when it
 * is drawn — so changing a target later re-reads every past day, and nothing is ever migrated.
 */
export function stateOf(habit: Habit, obs: Observation | undefined, date: LocalDate): DayState {
  if (date < habit.createdOn || (habit.retiredOn !== undefined && date >= habit.retiredOn)) return 'outside';
  if (!habit.days.includes(weekdayOf(date))) return 'off';
  if (!obs) return 'nothing';
  if (obs.planned) return 'planned';
  const v = obs.value;
  if (v === undefined) return 'nothing';
  const t = habit.target;
  switch (habit.kind) {
    case 'time':
      if (typeof v !== 'number') return 'nothing';
      if (t.band !== undefined && v <= t.band) return 'did';
      if (t.part !== undefined && v <= t.part) return 'partly';
      return 'nothing';
    case 'min':
    case 'count':
      if (typeof v !== 'number' || v <= 0) return 'nothing';
      return v >= (t.bar ?? 1) ? 'did' : 'partly';
    case 'tri':
      return v === 'did' ? 'did' : v === 'partly' ? 'partly' : 'nothing';
    case 'mood':
      // mood is recorded, never judged
      return typeof v === 'number' ? 'did' : 'nothing';
  }
}

/** Index observations by habit and date for fast lookup. */
export function indexObservations(observations: readonly Observation[]): Map<string, Observation> {
  const m = new Map<string, Observation>();
  for (const o of observations) m.set(`${o.habitId}|${o.date}`, o);
  return m;
}
export function lookup(index: ReadonlyMap<string, Observation>, habitId: string, date: LocalDate): Observation | undefined {
  return index.get(`${habitId}|${date}`);
}
