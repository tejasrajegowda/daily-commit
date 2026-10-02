import type { ClockMinute, HabitKind } from '../rules/types.ts';
import { isDayMinute } from '../rules/clock.ts';
import { fromUtcMs, toUtcMs } from '../rules/dates.ts';
import type { Settings } from './model.ts';
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

/** What is wrong with one setting's value, or undefined if nothing is. */
export function settingProblem(name: keyof Settings, value: unknown): string | undefined {
  switch (name) {
    case 'tz': return knownZone(value) ? undefined : 'not a timezone';
    case 'boundary':
    case 'wakePlan':
    case 'lightsOutPlan': return intIn(value, 0, 1439) ? undefined : 'not a clock time';
    case 'journeyStart': return realDate(value) ? undefined : 'not a date';
    case 'cuesOn': return typeof value === 'boolean' ? undefined : 'not on or off';
    case 'contact': return typeof value === 'string' ? undefined : 'not text';
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
