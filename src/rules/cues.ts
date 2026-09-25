import type { ClockMinute, Habit, LocalDate, Observation } from './types.ts';
import { addDays, daysBetween } from './dates.ts';
import { lookup, stateOf } from './state.ts';

// Notifications, in two kinds:
// - check-ins invite logging: at most two a day, at times set in Settings;
// - cues belong to one goal and ask nothing: never a question, never a count or a run, never
//   repeated or escalated if ignored.
// Everything due at the same minute arrives as one notification, nothing arrives between
// lights-out and waking, a rest day or a planned "not today" silences that goal's cues, and one
// switch turns every cue off.

export type CueTimes =
  | { readonly at: readonly ClockMinute[] }
  | { readonly every: number; readonly from: ClockMinute; readonly to: ClockMinute };

export interface Cue {
  readonly id: string;
  /** the goal it belongs to; null for a check-in */
  readonly habitId: string | null;
  readonly kind: 'checkin' | 'cue';
  readonly text: string;
  readonly times: CueTimes;
  /** after `afterDays` days, fire only at the times in `to` — a reminder that fades into a routine */
  readonly fade?: { readonly afterDays: number; readonly to: readonly ClockMinute[] };
  readonly enabled: boolean;
  readonly createdOn: LocalDate;
}

export interface CueSettings {
  /** the one switch for every cue; check-ins have their own times in Settings */
  readonly cuesOn: boolean;
  readonly wake: ClockMinute;
  readonly lightsOut: ClockMinute;
  /** minutes after midnight when one day turns into the next (04:00 by default) */
  readonly boundary?: ClockMinute;
}

export interface Notice {
  /** the app day it belongs to */
  readonly day: LocalDate;
  /** the calendar date it fires on (differs from `day` only after midnight, before the boundary) */
  readonly date: LocalDate;
  readonly at: ClockMinute;
  /** true when the notification should open the check-in */
  readonly checkin: boolean;
  readonly cueIds: readonly string[];
  readonly texts: readonly string[];
}

export const MAX_CHECKINS = 2;
export const MIN_EVERY = 15;
const DAY = 1440;

const validMinute = (t: number): boolean => Number.isInteger(t) && t >= 0 && t < DAY;

/** Between lights-out and waking, nothing is sent. Handles a lights-out either side of midnight. */
export function isQuiet(t: ClockMinute, s: CueSettings): boolean {
  if (s.lightsOut === s.wake) return false;
  return s.lightsOut > s.wake ? t >= s.lightsOut || t < s.wake : t >= s.lightsOut && t < s.wake;
}

/** The clock times a cue fires at on a given app day, before any silencing. */
export function timesOn(cue: Cue, day: LocalDate): ClockMinute[] {
  if (cue.fade && daysBetween(cue.createdOn, day) >= cue.fade.afterDays) return cue.fade.to.filter(validMinute);
  const t = cue.times;
  if ('at' in t) return t.at.filter(validMinute);
  const out: ClockMinute[] = [];
  if (!(t.every >= MIN_EVERY) || !validMinute(t.from) || !validMinute(t.to)) return out;
  for (let m = t.from; m <= t.to; m += t.every) out.push(m);
  return out;
}

/** Order within an app day: from the boundary round to the next boundary. */
const dayOrder = (t: ClockMinute, boundary: ClockMinute): number => (t - boundary + DAY) % DAY;

/** Every notification for one app day. */
export function cueSchedule(
  day: LocalDate,
  cues: readonly Cue[],
  habits: readonly Habit[],
  index: ReadonlyMap<string, Observation>,
  settings: CueSettings,
): Notice[] {
  const boundary = settings.boundary ?? 240;
  const byId = new Map(habits.map(h => [h.id, h]));
  const due: { at: ClockMinute; cue: Cue }[] = [];

  const checkins = cues
    .filter(c => c.enabled && c.kind === 'checkin' && c.createdOn <= day)
    .map(c => ({ cue: c, at: timesOn(c, day)[0] }))
    .filter((x): x is { cue: Cue; at: ClockMinute } => x.at !== undefined)
    .sort((a, b) => dayOrder(a.at, boundary) - dayOrder(b.at, boundary))
    .slice(0, MAX_CHECKINS);
  due.push(...checkins);

  if (settings.cuesOn) {
    for (const c of cues) {
      if (!c.enabled || c.kind !== 'cue' || c.createdOn > day || c.habitId === null) continue;
      const habit = byId.get(c.habitId);
      if (!habit) continue;
      const s = stateOf(habit, lookup(index, habit.id, day), day);
      if (s === 'off' || s === 'outside' || s === 'planned') continue;
      for (const at of timesOn(c, day)) due.push({ at, cue: c });
    }
  }

  const byMinute = new Map<ClockMinute, Cue[]>();
  for (const { at, cue } of due) {
    if (isQuiet(at, settings)) continue;
    const list = byMinute.get(at);
    if (list) { if (!list.includes(cue)) list.push(cue); } else byMinute.set(at, [cue]);
  }

  return [...byMinute.entries()]
    .sort((a, b) => dayOrder(a[0], boundary) - dayOrder(b[0], boundary))
    .map(([at, list]) => ({
      day,
      date: at < boundary ? addDays(day, 1) : day,
      at,
      checkin: list.some(c => c.kind === 'checkin'),
      cueIds: list.map(c => c.id),
      texts: [...new Set(list.map(c => c.text))],
    }));
}

/** The notifications for `days` app days starting at `firstDay` — what gets handed to Android. */
export function cueScheduleAhead(
  firstDay: LocalDate,
  days: number,
  cues: readonly Cue[],
  habits: readonly Habit[],
  index: ReadonlyMap<string, Observation>,
  settings: CueSettings,
): Notice[] {
  const out: Notice[] = [];
  for (let i = 0; i < days; i++) out.push(...cueSchedule(addDays(firstDay, i), cues, habits, index, settings));
  return out;
}
