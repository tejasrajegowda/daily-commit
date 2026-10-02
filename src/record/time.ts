import type { ClockMinute, LocalDate } from '../rules/types.ts';
import { clockMinuteOf, localDateOf } from '../rules/dates.ts';

// Which day it is, for the record. Days follow the home timezone and the boundary from Settings,
// never the phone's own timezone, and "today" never goes backwards: a phone whose clock is set back
// can't reopen a closed day.

/** The two settings that decide which day an instant belongs to. */
export interface DayRule {
  readonly tz: string;
  readonly boundary: ClockMinute;
}

/** The app day of an instant. */
export function appDay(ms: number, rule: DayRule): LocalDate {
  return localDateOf(ms, rule.tz, rule.boundary);
}

/** Today: the later of now's app day and the last write's, so a clock set back changes nothing. */
export function todayOf(nowMs: number, lastWriteMs: number | undefined, rule: DayRule): LocalDate {
  const now = appDay(nowMs, rule);
  if (lastWriteMs === undefined) return now;
  const last = appDay(lastWriteMs, rule);
  return last > now ? last : now;
}

/** The next change stamp: now, but always after the last one made on this device. */
export function nextStamp(nowMs: number, lastWriteMs: number | undefined): number {
  return lastWriteMs === undefined ? nowMs : Math.max(nowMs, lastWriteMs + 1);
}

/** Between midnight and the boundary, when the morning screen offers the day ahead. */
export function beforeBoundary(ms: number, rule: DayRule): boolean {
  return clockMinuteOf(ms, rule.tz) < rule.boundary;
}

/** How long a sheet's day outlives the boundary that ends it. */
export const SHEET_GRACE_MS = 10 * 60_000;

/** What a sheet remembers from when it opened: the moment, and the day it will judge its saves by. */
export interface Sheet {
  readonly openedAt: number;
  readonly today: LocalDate;
}

export function openSheet(nowMs: number, lastWriteMs: number | undefined, rule: DayRule): Sheet {
  return { openedAt: nowMs, today: todayOf(nowMs, lastWriteMs, rule) };
}

/**
 * The moment and the day a save is judged by. A sheet keeps its own until 10 minutes past the
 * boundary that ends its day, so a save just after 04:00 still lands where the person meant; after
 * that, or without a sheet, the save is judged at save time.
 */
export function judged(sheet: Sheet | undefined, nowMs: number, lastWriteMs: number | undefined, rule: DayRule): { readonly at: number; readonly today: LocalDate } {
  if (sheet && appDay(nowMs - SHEET_GRACE_MS, rule) <= sheet.today) return { at: sheet.openedAt, today: sheet.today };
  return { at: nowMs, today: todayOf(nowMs, lastWriteMs, rule) };
}
