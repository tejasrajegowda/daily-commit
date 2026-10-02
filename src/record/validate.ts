import type { ClockMinute, HabitKind } from '../rules/types.ts';
import { isDayMinute } from '../rules/clock.ts';

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
