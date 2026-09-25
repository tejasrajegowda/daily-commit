import type { LocalDate } from './types.ts';
import { daysBetween } from './dates.ts';

/** Day N of the journey, counted from its first day (day 1). It never goes backwards. */
export function dayNumber(start: LocalDate, today: LocalDate): number {
  return Math.max(1, daysBetween(start, today) + 1);
}

/** Views that arrive on a schedule, announced in advance: a trend through three points is noise. */
export const OPENS_ON = {
  /** the weekly line through a clock-time habit */
  timeTrend: 21,
  /** "am I improving?" */
  improving: 30,
  /** the months view */
  months: 35,
  /** the monthly review, and with it "what seems to go well together" */
  monthlyReview: 60,
} as const;

export function hasOpened(view: keyof typeof OPENS_ON, day: number): boolean {
  return day >= OPENS_ON[view];
}
