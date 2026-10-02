import type { ClockMinute, DayMinute, Habit, HabitKind, LocalDate, Observation } from '../rules/types.ts';
import type { Cue } from '../rules/cues.ts';

// The record as the app works with it once unlocked: the rules' own shapes and units, plus the
// words and bookkeeping the rules never see. Held in memory only while unlocked.

export interface HabitRecord extends Habit {
  readonly name: string;
  readonly sub?: string;
  /** where it sits in its list */
  readonly order: number;
  /** when the offer to stop asking was taken (ms) */
  readonly settledAt?: number;
  /** the habit this one took over from, when the way it is recorded changed */
  readonly replaces?: string;
}

export interface ObservationRecord extends Observation {
  /** the habit's kind when this was logged: a second guard, since a kind never changes */
  readonly kind: HabitKind;
  /** when it was logged (ms) */
  readonly loggedAt: number;
  /** logged for a day before the day it was logged on */
  readonly isBackfill: boolean;
  /** changed after its day was closed */
  readonly editedAfterClose: boolean;
}

export interface DayRecord {
  readonly date: LocalDate;
  readonly closedAt?: number;
  readonly lightsOut?: DayMinute;
  readonly restDay: boolean;
  readonly reopenedCount: number;
  readonly intent?: string;
  readonly remark?: string;
  readonly badNightNote?: string;
}

export interface EntryRecord {
  readonly id: string;
  readonly date: LocalDate;
  readonly body: string;
  /** set while it waits in the trash (ms) */
  readonly trashedAt?: number;
}

export interface NotYetRecord {
  readonly id: string;
  readonly text: string;
  readonly why?: string;
  readonly startedAt?: number;
  readonly trashedAt?: number;
}

export interface CueRecord extends Cue {
  /** a private reminder's words stay locked under the words key and never reach a notification */
  readonly private: boolean;
}

export interface ReviewRecord {
  /** `w:<the Monday>` or `m:YYYY-MM` */
  readonly key: string;
  readonly periodStart: LocalDate;
  readonly periodEnd: LocalDate;
  readonly answers: Readonly<Record<string, string>>;
  readonly closedAt?: number;
}

export interface Settings {
  /** the home timezone: days follow it, never the phone's */
  readonly tz: string;
  readonly boundary: ClockMinute;
  readonly journeyStart: LocalDate;
  readonly wakePlan: ClockMinute;
  readonly lightsOutPlan: ClockMinute;
  readonly cuesOn: boolean;
  readonly contact?: string;
}

/** Everything open, in memory. Changed only by record/, after a write has committed. */
export interface Model {
  settings: Settings;
  readonly habits: Map<string, HabitRecord>;
  /** keyed `<habit id>|<date>` */
  readonly observations: Map<string, ObservationRecord>;
  readonly days: Map<LocalDate, DayRecord>;
  readonly entries: Map<string, EntryRecord>;
  readonly notyet: Map<string, NotYetRecord>;
  readonly cues: Map<string, CueRecord>;
  readonly reviews: Map<string, ReviewRecord>;
}
