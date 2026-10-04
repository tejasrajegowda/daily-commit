import type { HabitRecord, Model } from '../record/model.ts';
import type { RulesInput } from '../record/read.ts';
import { clockOfDay } from '../rules/clock.ts';
import { addDays, daysBetween, datesFrom, toUtcMs, weekdayOf } from '../rules/dates.ts';
import { focusDone, heatLevel, type HeatLevel } from '../rules/heat.ts';
import { dayNumber, hasOpened, OPENS_ON } from '../rules/journey.ts';
import { lookup, stateOf, tierOn } from '../rules/state.ts';
import { habitNumbers, type HabitNumbers } from '../rules/stats.ts';
import type { DayState, LocalDate } from '../rules/types.ts';
import { countWord } from '../rules/words.ts';

// What Look back shows, from the record: evidence cells, the months field, the wake-time trend
// and the sentence. It counts only up: nothing here can go down, and nothing is shown as a miss.

const DOW3 = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MON = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const MON3 = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const LETTER = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];

const utc = (d: LocalDate) => new Date(toUtcMs(d));
export const shortDate = (d: LocalDate) => `${utc(d).getUTCDate()} ${MON3[utc(d).getUTCMonth()]}`;
export const longDay = (d: LocalDate) => `${utc(d).getUTCDate()} ${MON[utc(d).getUTCMonth()]}`;
export const monthName = (d: LocalDate) => MON[utc(d).getUTCMonth()] ?? '';
const hm = (m: number) => `${String(Math.floor(m / 60) % 24).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
const dur = (m: number) => { const h = Math.floor(m / 60), r = m % 60; return h ? (r ? `${h}h ${r}m` : `${h}h`) : `${r}m`; };

/** A day's state as the stylesheet draws it. */
export function cellClass(state: DayState): string {
  return { did: 'd', partly: 'p', planned: 'pl', nothing: '', off: 'off', outside: 'na' }[state];
}

/** The habits in Focus today, and the ones recorded alongside (mood is never scored, so never here). */
export function tiers(input: RulesInput, today: LocalDate) {
  const habits = [...input.habits].filter(h => h.kind !== 'mood').sort((a, b) => a.order - b.order);
  return {
    focus: habits.filter(h => tierOn(h, today) === 'focus') as HabitRecord[],
    log: habits.filter(h => tierOn(h, today) === 'log') as HabitRecord[],
  };
}

/** A value as the day panel and the cell titles write it. */
export function valueWords(habit: HabitRecord, input: RulesInput, date: LocalDate): string {
  const obs = lookup(input.index, habit.id, date);
  const s = stateOf(habit, obs, date);
  if (s === 'off') return 'not asked that day';
  if (s === 'outside') return '—';
  if (s === 'planned') return 'planned rest';
  const v = obs?.value;
  if (v === undefined) return '—';
  if (typeof v === 'string') return v === 'did' ? 'did it' : v === 'partly' ? 'partly' : 'not today';
  if (habit.kind === 'time') return hm(clockOfDay(v));
  if (habit.kind === 'min') return dur(v);
  return String(v);
}

export interface Cell {
  readonly date: LocalDate;
  readonly cls: string;
  readonly now: boolean;
  readonly future: boolean;
  readonly title: string;
}

/** One habit's cells from `from` to `to`; days after today are drawn as outlines still to come. */
export function cells(input: RulesInput, habit: HabitRecord, from: LocalDate, to: LocalDate, today: LocalDate): Cell[] {
  return datesFrom(from, to).map(date => {
    if (date > today) return { date, cls: 'fut', now: false, future: true, title: `${shortDate(date)} · still to come` };
    const s = stateOf(habit, lookup(input.index, habit.id, date), date);
    return { date, cls: cellClass(s), now: date === today, future: false, title: `${DOW3[utc(date).getUTCDay()]} ${shortDate(date)} · ${habit.name}: ${valueWords(habit, input, date)}` };
  });
}

/** The weekday letters under the cells. */
export const axisLetters = (from: LocalDate, to: LocalDate) => datesFrom(from, to).map(d => ({ date: d, letter: LETTER[weekdayOf(d)] ?? '' }));

/** The week labels above the cells: one span per week, labelled when it is three days or wider. */
export function weekSpans(from: LocalDate, to: LocalDate): { readonly span: number; readonly label: string }[] {
  const out: { span: number; label: string }[] = [];
  let d = from;
  while (d <= to) {
    const span = Math.min(7 - weekdayOf(d), daysBetween(d, to) + 1);
    out.push({ span, label: span >= 3 ? shortDate(d) : '' });
    d = addDays(d, span);
  }
  return out;
}

/** The evidence window: up to four weeks back, through the end of this week. */
export function window(start: LocalDate, today: LocalDate): { readonly from: LocalDate; readonly to: LocalDate; readonly span: number } {
  const days = Math.min(dayNumber(start, today), 28);
  const from = addDays(today, -(days - 1));
  const to = addDays(today, 6 - weekdayOf(today));
  return { from, to, span: daysBetween(from, to) + 1 };
}

export const numbersOf = (input: RulesInput, habit: HabitRecord, start: LocalDate, today: LocalDate): HabitNumbers =>
  habitNumbers(habit, input.index, start, today);

/** The small word under a count: what was counted. */
export const countUnit = (habit: HabitRecord) => (habit.kind === 'min' ? 'sessions' : habit.kind === 'time' ? 'mornings' : 'days');

/** The line under a habit's name. */
export function unitLine(habit: HabitRecord, n: HabitNumbers): string {
  if (habit.kind === 'min') return `sessions · ${dur(n.minutes)} in all`;
  if (habit.kind === 'time' && habit.target.band !== undefined) return `mornings by ${hm(habit.target.band)}`;
  return 'days';
}

export type Words = readonly { readonly text: string; readonly bold?: boolean }[];

/** The sentence about the first habit in Focus, in words: only ever counts up. */
export function sentence(input: RulesInput, model: Model, today: LocalDate): Words {
  const start = model.settings.journeyStart;
  if (dayNumber(start, today) === 1) {
    return [{ text: 'The record starts today, ' }, { text: longDay(today), bold: true }, { text: '. Everything on this screen grows from here, and nothing on it can go down.' }];
  }
  const habit = tiers(input, today).focus[0];
  if (!habit) return [{ text: 'Nothing is in Focus yet. Plan is where a habit joins it.' }];
  const n = numbersOf(input, habit, start, today);
  const what = habit.kind === 'time' && habit.target.band !== undefined ? `${habit.name} by ${hm(habit.target.band)}` : habit.name;
  const out: { text: string; bold?: boolean }[] = [{ text: `${what} on ` }, { text: `${countWord(n.did)} ${n.did === 1 ? countUnit(habit).slice(0, -1) : countUnit(habit)}`, bold: true }];
  if (dayNumber(start, today) <= 30) out.push({ text: '.' });
  else {
    let last30 = 0;
    for (const d of datesFrom(addDays(today, -29), today)) if (stateOf(habit, lookup(input.index, habit.id, d), d) === 'did') last30++;
    out.push({ text: ` since ${longDay(start)} — ` }, { text: String(last30), bold: true }, { text: ' of them in the last thirty days.' });
  }
  if (n.gaps > 0 && n.cameBack === n.gaps) {
    out.push({ text: n.gaps === 1 ? ' There was one gap, and you were back the next day.' : ` There were ${countWord(n.gaps)} gaps, and ${n.gaps > 2 ? 'every time' : 'both times'} you were back the next day.` });
  } else if (n.cameBack > 0) {
    out.push({ text: ' You came back the day after a gap ' }, { text: `${countWord(n.cameBack)} ${n.cameBack === 1 ? 'time' : 'times'}`, bold: true }, { text: '.' });
  }
  return out;
}

export interface FieldMonth {
  readonly label: string;
  /** empty cells before the 1st, so weeks line up */
  readonly lead: number;
  readonly days: readonly { readonly date: LocalDate; readonly level: HeatLevel; readonly done: number; readonly now: boolean }[];
}

/** The months field: one cell per day, brighter for more of what was in Focus that day. */
export function monthsField(input: RulesInput, start: LocalDate, today: LocalDate): FieldMonth[] {
  const months: { label: string; lead: number; days: FieldMonth['days'][number][] }[] = [];
  for (const date of datesFrom(start, today)) {
    const key = date.slice(0, 7);
    if (months.at(-1)?.label !== key) months.push({ label: key, lead: weekdayOf(date), days: [] });
    const done = focusDone(input.habits, input.index, date);
    months.at(-1)?.days.push({ date, level: heatLevel(done), done, now: date === today });
  }
  return months.map(m => ({ ...m, label: monthName(`${m.label}-01`) }));
}

export interface Trend {
  readonly dots: readonly { readonly day: number; readonly minute: number }[];
  /** each week's middle, from day 21, for weeks with three or more times */
  readonly line: readonly { readonly day: number; readonly minute: number }[];
  readonly days: number;
}

/** A time habit's recorded clock times as dots, and the weekly middle once the trend has opened. */
export function trend(input: RulesInput, habit: HabitRecord, start: LocalDate, today: LocalDate): Trend {
  const days = dayNumber(start, today);
  const dots: { day: number; minute: number }[] = [];
  for (const [i, date] of datesFrom(start, today).entries()) {
    const v = lookup(input.index, habit.id, date)?.value;
    if (typeof v === 'number') dots.push({ day: i, minute: clockOfDay(v) });
  }
  const line: { day: number; minute: number }[] = [];
  if (hasOpened('timeTrend', days)) {
    for (let w = 0; w < days; w += 7) {
      const week = dots.filter(d => d.day >= w && d.day < w + 7).map(d => d.minute).sort((a, b) => a - b);
      if (week.length >= 3) line.push({ day: Math.min(days - 1, w + 3), minute: week[Math.floor(week.length / 2)] ?? 0 });
    }
  }
  return { dots, line, days };
}

/** The views still to come, said in advance: a trend through three points is noise. */
export function opensLater(day: number): { readonly what: string; readonly when: string }[] {
  const out: { what: string; when: string }[] = [];
  if (day < OPENS_ON.timeTrend) out.push({ what: 'Wake-time trend', when: `day 21 · in ${OPENS_ON.timeTrend - day} days` });
  if (day < OPENS_ON.improving) out.push({ what: 'Am I improving?', when: `day 30 · in ${OPENS_ON.improving - day} days` });
  if (day < OPENS_ON.months) out.push({ what: 'The shape of months', when: `day 35 · in ${OPENS_ON.months - day} days` });
  if (day < OPENS_ON.monthlyReview) out.push({ what: 'What actually helps', when: 'day 60 · monthly review' });
  return out;
}
