import type { ClockMinute, HabitKind, PlannedReason, Target } from '../rules/types.ts';
import { isDayMinute } from '../rules/clock.ts';
import { fromUtcMs, toUtcMs } from '../rules/dates.ts';
import { MIN_EVERY } from '../rules/cues.ts';
import type { CueRecord, HabitRecord, Settings } from './model.ts';
import { settingEntries } from './mapping.ts';

// The checks every write makes before anything is locked or stored.

const intIn = (v: unknown, lo: number, hi: number): boolean => typeof v === 'number' && Number.isInteger(v) && v >= lo && v <= hi;

/** Whether a value fits its habit's kind. */
export function validValue(kind: HabitKind, value: unknown, boundary: ClockMinute): boolean {
  switch (kind) {
    case 'time': return typeof value === 'number' && isDayMinute(value, boundary);
    case 'min': return intIn(value, 0, 1440);
    case 'count': return intIn(value, 0, 999);
    case 'mood': return intIn(value, 1, 5);
    case 'tri': return value === 'did' || value === 'partly' || value === 'not';
  }
}

function realDate(v: unknown): boolean {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  try {
    return fromUtcMs(toUtcMs(v)) === v;
  } catch {
    return false;
  }
}

function knownZone(v: unknown): boolean {
  if (typeof v !== 'string' || v === '') return false;
  try {
    new Intl.DateTimeFormat('en', { timeZone: v });
    return true;
  } catch {
    return false;
  }
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;
const labelOk = (v: unknown) => typeof v === 'string' && v.trim().length >= 1 && v.length <= 40;

/** A day's shape: a window, blocks inside it, steps in time order, and lights-out, all clock times. */
function shapeProblem(v: unknown): string | undefined {
  if (!isObj(v) || !isObj(v.window) || !Array.isArray(v.blocks) || !Array.isArray(v.steps)) return 'not a day shape';
  const { from, to } = v.window;
  if (!intIn(from, 0, 1439) || !intIn(to, 0, 1439) || (to as number) <= (from as number)) return 'its window is not a span of the day';
  if (!intIn(v.lightsOut, 0, 1439)) return 'lights-out is not a clock time';
  for (const b of v.blocks) {
    if (!isObj(b) || !labelOk(b.label) || !intIn(b.start, 0, 1439) || !intIn(b.end, 0, 1439)) return 'a block is not a block';
    if ((b.start as number) >= (b.end as number) || (b.start as number) < (from as number) || (b.end as number) > (to as number)) return 'a block is outside its window';
  }
  let last = -1;
  for (const s of v.steps) {
    if (!isObj(s) || !labelOk(s.label) || !intIn(s.at, 0, 1439)) return 'a step is not a step';
    if ((s.at as number) <= last) return 'the steps are not in time order';
    last = s.at as number;
  }
  return undefined;
}

function shapesProblem(v: unknown): string | undefined {
  if (!isObj(v)) return 'not a weekday and a weekend shape';
  return shapeProblem(v.weekday) ?? shapeProblem(v.weekend);
}

/** What is wrong with one setting's value, or undefined if nothing is. */
export function settingProblem(name: keyof Settings, value: unknown): string | undefined {
  switch (name) {
    case 'tz': return knownZone(value) ? undefined : 'not a timezone';
    case 'boundary':
    case 'wakePlan':
    case 'lightsOutPlan': return intIn(value, 0, 1439) ? undefined : 'not a clock time';
    case 'journeyStart': return realDate(value) ? undefined : 'not a date';
    case 'cuesOn': return typeof value === 'boolean' ? undefined : 'not on or off';
    case 'contact':
    case 'badNightNote': return typeof value === 'string' ? undefined : 'not text';
    case 'paused': return typeof value === 'boolean' ? undefined : 'not on or off';
    case 'dayShapes': return shapesProblem(value);
  }
}

const REQUIRED = ['tz', 'boundary', 'journeyStart', 'wakePlan', 'lightsOutPlan', 'cuesOn'] as const;

/** What is wrong with a whole set of settings, or undefined if nothing is. */
export function settingsProblem(s: Settings): string | undefined {
  for (const name of REQUIRED) if (s[name] === undefined) return `${name}: missing`;
  for (const [name, value] of settingEntries(s)) {
    const problem = settingProblem(name, value);
    if (problem) return `${name}: ${problem}`;
  }
  return undefined;
}

const WEEKDAYS: readonly number[] = [0, 1, 2, 3, 4, 5, 6];
const REASONS: readonly unknown[] = ['meeting', 'travelling', 'unwell', 'chose', 'rest'];

export function validReason(r: unknown): r is PlannedReason {
  return REASONS.includes(r);
}

function validDays(days: readonly number[]): boolean {
  return days.length > 0 && new Set(days).size === days.length && days.every(d => WEEKDAYS.includes(d));
}

/** Each entry starts on a real date, strictly after the one before. */
function inOrder(list: readonly { readonly from: string }[]): boolean {
  return list.every((e, i) => realDate(e.from) && (i === 0 || (list[i - 1]?.from ?? '') < e.from));
}

function targetProblem(kind: HabitKind, t: Target, boundary: ClockMinute): string | undefined {
  switch (kind) {
    case 'time':
      if (t.bar !== undefined || t.aim !== undefined) return 'a time habit has a band, not a bar';
      if ((t.band !== undefined && !isDayMinute(t.band, boundary)) || (t.part !== undefined && !isDayMinute(t.part, boundary))) return 'a target is not a time of day';
      if (t.band !== undefined && t.part !== undefined && t.part < t.band) return '"partly" must come after the band';
      return undefined;
    case 'min':
    case 'count': {
      const max = kind === 'min' ? 1440 : 999;
      if (t.band !== undefined || t.part !== undefined) return 'this kind has a bar, not a band';
      if ((t.bar !== undefined && !intIn(t.bar, 1, max)) || (t.aim !== undefined && !intIn(t.aim, 1, max))) return 'the bar or aim is out of range';
      return undefined;
    }
    case 'tri':
    case 'mood':
      return Object.values(t).some(v => v !== undefined) ? 'this kind has no target' : undefined;
  }
}

/** What is wrong with a habit as it would be stored, or undefined if nothing is. */
export function habitProblem(h: HabitRecord, boundary: ClockMinute): string | undefined {
  if (h.name.trim() === '' || h.name.length > 80) return 'a habit needs a name of up to 80 characters';
  const p = h.periods;
  if (p.length === 0 || !inOrder(p)) return 'its periods are out of order';
  for (let i = 0; i < p.length; i++) {
    const e = p[i], next = p[i + 1];
    if (!e) continue;
    if (e.until !== undefined && (!realDate(e.until) || e.until <= e.from)) return 'a period ends before it starts';
    if (next && (e.until === undefined || e.until > next.from)) return 'its periods overlap';
  }
  if (h.schedule.length === 0 || !inOrder(h.schedule)) return 'its weekday history is out of order';
  if (h.schedule.some(s => !validDays(s.days) || (s.asked !== 'morning' && s.asked !== 'evening'))) return 'its weekdays are not valid';
  if (h.tierHistory.length === 0 || !inOrder(h.tierHistory) || h.tierHistory.some(t => t.tier !== 'focus' && t.tier !== 'log')) return 'its tier history is not valid';
  const first = p[0]?.from ?? '';
  if ((h.schedule[0]?.from ?? '') > first || (h.tierHistory[0]?.from ?? '') > first) return 'its weekdays or tier start after it does';
  return targetProblem(h.kind, h.target, boundary);
}

/** What is wrong with a reminder, or undefined if nothing is. */
export function cueProblem(c: CueRecord, boundary: ClockMinute): string | undefined {
  if (c.kind === 'cue' ? c.habitId === null : c.habitId !== null) return 'a cue belongs to a habit, a check-in to none';
  if (c.text.length > 200) return 'the reminder text is too long';
  if (!realDate(c.createdOn)) return 'the reminder has no start date';
  const t = c.times;
  if ('at' in t) {
    if (t.at.length === 0 || !t.at.every(m => intIn(m, 0, 1439))) return 'its times are not clock times';
  } else {
    if (!intIn(t.every, MIN_EVERY, 1440) || !intIn(t.from, 0, 1439) || !intIn(t.to, 0, 1439)) return 'its range is not valid';
    if ((t.to - boundary + 1440) % 1440 < (t.from - boundary + 1440) % 1440) return 'its range runs past the end of the day';
  }
  if (c.fade && (!intIn(c.fade.afterDays, 1, 365) || c.fade.to.length === 0 || !c.fade.to.every(m => intIn(m, 0, 1439)))) return 'its fade is not valid';
  return undefined;
}
