import type { ClockMinute, LocalDate, Weekday } from './types.ts';

// Calendar arithmetic on 'YYYY-MM-DD' strings, done in UTC so no local timezone can shift a day.

const DAY_MS = 86_400_000;

export function toUtcMs(date: LocalDate): number {
  const [y, m, d] = date.split('-').map(Number);
  if (!y || !m || !d) throw new Error(`not a date: ${date}`);
  return Date.UTC(y, m - 1, d);
}

export function fromUtcMs(ms: number): LocalDate {
  return new Date(ms).toISOString().slice(0, 10);
}

export function addDays(date: LocalDate, n: number): LocalDate {
  return fromUtcMs(toUtcMs(date) + n * DAY_MS);
}

/** Whole days from `from` to `to` (negative if `to` is earlier). */
export function daysBetween(from: LocalDate, to: LocalDate): number {
  return Math.round((toUtcMs(to) - toUtcMs(from)) / DAY_MS);
}

/** Monday = 0 … Sunday = 6. */
export function weekdayOf(date: LocalDate): Weekday {
  return ((new Date(toUtcMs(date)).getUTCDay() + 6) % 7) as Weekday;
}

/** Every date from `from` to `to`, inclusive. */
export function datesFrom(from: LocalDate, to: LocalDate): LocalDate[] {
  const out: LocalDate[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
}

/**
 * Which day an instant belongs to, in the owner's home timezone, with the day ending at
 * `boundary` (04:00 by default): something logged at 00:30 belongs to the day you were awake for.
 */
export function localDateOf(instantMs: number, timeZone: string, boundary: ClockMinute = 240): LocalDate {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(instantMs));
  const get = (t: string) => parts.find(p => p.type === t)?.value ?? '';
  const date = `${get('year')}-${get('month')}-${get('day')}`;
  const minute = Number(get('hour')) * 60 + Number(get('minute'));
  return minute < boundary ? addDays(date, -1) : date;
}

/** The clock minute of an instant in the owner's home timezone. */
export function clockMinuteOf(instantMs: number, timeZone: string): ClockMinute {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .formatToParts(new Date(instantMs));
  const get = (t: string) => Number(parts.find(p => p.type === t)?.value ?? 0);
  return get('hour') * 60 + get('minute');
}
