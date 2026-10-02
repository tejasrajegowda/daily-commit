// The shapes the rules work on. Plain data only — no storage, no screen, no clock.
// Names and free text never reach the rules: they work on ids, dates, times and values.

/** A calendar day in the owner's home timezone, 'YYYY-MM-DD'. */
export type LocalDate = string;
/** Minutes after midnight, 0–1439, for clock values such as a wake-up time. */
export type ClockMinute = number;
/** Monday = 0 … Sunday = 6. */
export type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6;

export type HabitKind =
  | 'time'   // a clock time is recorded (e.g. getting up)
  | 'tri'    // did it / partly / not today
  | 'min'    // minutes are recorded
  | 'count'  // a small count is recorded
  | 'mood';  // 1–5, never scored and never joined to habits before day 60
export type Tier = 'focus' | 'log';
export type Asked = 'morning' | 'evening';
export type TriValue = 'did' | 'partly' | 'not';
export type PlannedReason = 'meeting' | 'travelling' | 'unwell' | 'chose' | 'rest';

/** Targets are applied when something is drawn, never stored as a verdict. */
export interface Target {
  /** time: at or before this counts as "did it" */
  readonly band?: ClockMinute;
  /** time: at or before this (and after `band`) counts as "partly" */
  readonly part?: ClockMinute;
  /** min / count: at or above this counts as "did it" */
  readonly bar?: number;
  /** min: the aim — shown, never used to judge */
  readonly aim?: number;
}

export interface TierPeriod {
  readonly tier: Tier;
  readonly from: LocalDate;
}

/** A stretch of days a habit is part of the plan: from `from`, up to but not including `until`. */
export interface HabitPeriod {
  readonly from: LocalDate;
  /** the first day it is no longer part of the plan; absent while it still is */
  readonly until?: LocalDate;
}

/** Which weekdays a habit is asked on, and when, from a given day on. */
export interface ScheduleEntry {
  readonly from: LocalDate;
  readonly days: readonly Weekday[];
  readonly asked: Asked;
}

export interface Habit {
  readonly id: string;
  readonly kind: HabitKind;
  /** when it was part of the plan — oldest first, never overlapping; it can leave and come back */
  readonly periods: readonly HabitPeriod[];
  /** which weekdays it was asked on, and when — oldest first, so a change never rewrites the past */
  readonly schedule: readonly ScheduleEntry[];
  readonly target: Target;
  /** which tier it was in, from which day — oldest first */
  readonly tierHistory: readonly TierPeriod[];
}

/** One recorded thing, for one habit, on one day. The raw value — never a verdict. */
export interface Observation {
  readonly habitId: string;
  readonly date: LocalDate;
  readonly value?: number | TriValue;
  readonly planned?: PlannedReason;
}

/**
 * The only six things a habit can be on a day.
 * There is no "missed": a day answered "not today" and a day never answered are both `nothing`.
 */
export type DayState =
  | 'did'
  | 'partly'
  | 'planned'   // declared in advance, or a rest day
  | 'nothing'   // not today, or never answered — deliberately the same
  | 'off'       // not a day this habit is asked
  | 'outside';  // not part of the plan that day: before it began, while away, or after it retired
