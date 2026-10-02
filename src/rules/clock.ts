import type { Asked, ClockMinute, DayMinute } from './types.ts';

// Clock times placed on their app day. A day runs from the boundary (04:00 unless Settings says
// otherwise) to the next one, so a time typed in after midnight still belongs to the evening before.

const DAY = 1440;

/** When one day turns into the next, unless Settings says otherwise: 04:00. */
export const DEFAULT_BOUNDARY: ClockMinute = 240;

/** The last DayMinute an app day can hold: the minute before the next boundary (03:59 is 1679). */
export function lastDayMinute(boundary: ClockMinute = DEFAULT_BOUNDARY): DayMinute {
  return DAY + boundary - 1;
}

/**
 * A clock time typed in for an app day, as a DayMinute.
 * - Asked in the evening: a time before the boundary is after midnight, so 00:30 becomes 1470.
 * - Asked in the morning: kept as it is. A wake-up at 03:50 belongs to the day ahead, where it is 230.
 */
export function toDayMinute(clock: ClockMinute, asked: Asked, boundary: ClockMinute = DEFAULT_BOUNDARY): DayMinute {
  return asked === 'evening' && clock < boundary ? clock + DAY : clock;
}

/** The clock time a DayMinute is shown as: 1470 → 30, which reads 00:30. */
export function clockOfDay(minute: DayMinute): ClockMinute {
  return minute % DAY;
}

/** Whether a number is a DayMinute an app day can hold. */
export function isDayMinute(minute: number, boundary: ClockMinute = DEFAULT_BOUNDARY): boolean {
  return Number.isInteger(minute) && minute >= 0 && minute <= lastDayMinute(boundary);
}
