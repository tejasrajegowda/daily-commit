import type { Asked, DayState, Habit, LocalDate, Observation, ScheduleEntry, Tier } from './types.ts';
import { weekdayOf } from './dates.ts';

/** Whether the habit is part of the plan on this day: inside one of its periods. */
export function inPlan(habit: Habit, date: LocalDate): boolean {
  return habit.periods.some(p => p.from <= date && (p.until === undefined || date < p.until));
}

/** Whether the habit has left the plan and not come back: its last period has ended. */
export function isRetired(habit: Habit): boolean {
  return habit.periods.at(-1)?.until !== undefined;
}

/** The schedule in force on a day: the latest entry starting on or before it, or none before the first. */
export function scheduleOn(habit: Habit, date: LocalDate): ScheduleEntry | undefined {
  let found: ScheduleEntry | undefined;
  for (const s of habit.schedule) if (s.from <= date) found = s;
  return found;
}

function onSchedule(habit: Habit, date: LocalDate): boolean {
  return scheduleOn(habit, date)?.days.includes(weekdayOf(date)) ?? false;
}

/** Whether the habit is asked on this day at all: part of the plan, and one of that day's weekdays. */
export function isAsked(habit: Habit, date: LocalDate): boolean {
  return inPlan(habit, date) && onSchedule(habit, date);
}

/** When the habit is asked on a day — morning or evening — or undefined on a day it isn't asked. */
export function askedOn(habit: Habit, date: LocalDate): Asked | undefined {
  return isAsked(habit, date) ? scheduleOn(habit, date)?.asked : undefined;
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
 * A recorded value wins over a plan made in advance.
 */
export function stateOf(habit: Habit, obs: Observation | undefined, date: LocalDate): DayState {
  if (!inPlan(habit, date)) return 'outside';
  if (!onSchedule(habit, date)) return 'off';
  const v = obs?.value;
  if (v === undefined) return obs?.planned ? 'planned' : 'nothing';
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
