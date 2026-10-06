import type { HabitRecord, Model } from '../record/model.ts';
import type { RulesInput } from '../record/read.ts';
import { addDays, weekdayOf } from '../rules/dates.ts';
import { dayNumber, hasOpened } from '../rules/journey.ts';
import { goesWellTogether, type Together } from '../rules/patterns.ts';
import { offersToSettle } from '../rules/settled.ts';
import { tierOn } from '../rules/state.ts';
import { doneAndAsked } from '../rules/stats.ts';
import type { LocalDate } from '../rules/types.ts';
import { band, bandWords, momentum, type Momentum } from '../rules/words.ts';

// The two reviews, in words, never numbers. The Sunday review covers Monday to that Sunday on a
// Sunday, and the last finished Monday to Sunday on any other day (C-4); the monthly review, from
// day 60, covers the last finished calendar month.

const MON = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const hm = (m: number) => `${String(Math.floor(m / 60) % 24).padStart(2, '0')}:${String(Math.round(m) % 60).padStart(2, '0')}`;
const dur = (m: number) => { const r5 = Math.round(m / 5) * 5, h = Math.floor(r5 / 60), r = r5 % 60; return h ? (r ? `${h}h ${r}m` : `${h}h`) : `${r}m`; };

export interface WeekRow {
  readonly habit: HabitRecord;
  /** "most days", "about half", "a few days", or undefined for a quiet week */
  readonly words?: string;
  readonly momentum?: Momentum;
}

export interface WeekView {
  /** the Monday, the key of the review */
  readonly monday: LocalDate;
  readonly sunday: LocalDate;
  /** the first week hasn't finished yet: its days are drawn, but nothing is said about them */
  readonly empty: boolean;
  readonly weekNumber: number;
  readonly focus: readonly WeekRow[];
  readonly log: readonly WeekRow[];
}

/** The week the Sunday review covers: Monday to today on a Sunday, else the last finished week (C-4). */
export function lastWeek(today: LocalDate): { readonly monday: LocalDate; readonly sunday: LocalDate } {
  const weekday = weekdayOf(today);
  const sunday = weekday === 6 ? today : addDays(today, -(weekday + 1));
  return { monday: addDays(sunday, -6), sunday };
}

export function weekView(input: RulesInput, model: Model, today: LocalDate): WeekView {
  const start = model.settings.journeyStart;
  const last = lastWeek(today);
  const empty = last.sunday < start;
  const monday = empty ? addDays(start, -weekdayOf(start)) : last.monday;
  const sunday = addDays(monday, 6);
  const row = (habit: HabitRecord, scored: boolean): WeekRow => {
    if (empty) return { habit };
    const now = doneAndAsked(habit, input.index, monday, sunday);
    const before = doneAndAsked(habit, input.index, addDays(monday, -7), addDays(sunday, -7));
    const b = band(now.done, now.asked);
    return { habit, words: b ? bandWords(b, 'week') : undefined, momentum: scored && addDays(monday, -7) >= start ? momentum(before.done, now.done) : undefined };
  };
  const habits = [...input.habits].filter(h => h.kind !== 'mood').sort((a, b) => a.order - b.order) as HabitRecord[];
  return {
    monday, sunday, empty,
    weekNumber: Math.floor((dayNumber(start, sunday) - 1) / 7) + 1,
    focus: habits.filter(h => tierOn(h, sunday) === 'focus').map(h => row(h, true)),
    log: habits.filter(h => tierOn(h, sunday) === 'log').map(h => row(h, false)),
  };
}

export interface MonthView {
  readonly open: boolean;
  /** the day the review opens, when it hasn't yet */
  readonly opensOn: LocalDate;
  readonly name: string;
  /** the 1st of the month, the key of the review */
  readonly first: LocalDate;
  readonly from: LocalDate;
  readonly to: LocalDate;
  readonly rows: readonly { readonly habit: HabitRecord; readonly words: string }[];
  readonly together: readonly string[];
  /** a habit steady enough to be offered to settle, if any */
  readonly settle?: HabitRecord;
}

export function monthView(input: RulesInput, model: Model, today: LocalDate): MonthView {
  const start = model.settings.journeyStart;
  const day = dayNumber(start, today);
  const first = `${today.slice(0, 7)}-01`;
  const prevFirst = addDays(first, -1).slice(0, 7) + '-01';
  const to = addDays(first, -1);
  const from = prevFirst < start ? start : prevFirst;
  const name = MON[Number(prevFirst.slice(5, 7)) - 1] ?? '';
  const opensOn = addDays(start, 59);
  if (!hasOpened('monthlyReview', day)) return { open: false, opensOn, name, first: prevFirst, from, to, rows: [], together: [] };
  const habits = [...input.habits].sort((a, b) => a.order - b.order) as HabitRecord[];
  const focus = habits.filter(h => h.kind !== 'mood' && tierOn(h, to) === 'focus');
  const rows = focus.map(habit => {
    const { done, asked } = doneAndAsked(habit, input.index, from, to);
    return { habit, words: bandWords(band(done, asked), 'month') };
  });
  const pairs = focus.flatMap(w => habits.filter(t => t.id !== w.id).map(t => ({ when: w.id, then: t.id })));
  const byId = new Map(habits.map(h => [h.id, h]));
  const together = goesWellTogether(input.habits, input.index, pairs, from, to, day).slice(0, 3).map(t => togetherWords(t, byId));
  const yesterday = addDays(today, -1);
  const settle = focus.find(h => h.settledAt === undefined && offersToSettle(h, input.index, yesterday));
  return { open: true, opensOn, name, first: prevFirst, from, to, rows, together, settle };
}

/** One thing that went well together, as a plain sentence: a pattern, never a cause. */
export function togetherWords(t: Together, byId: ReadonlyMap<string, HabitRecord>): string {
  const when = byId.get(t.when), then = byId.get(t.then);
  if (!when || !then) return '';
  // A habit's name is free text ("Walk", "Ate well"), so it is used as a label, never as a verb.
  const on = `On the days ${when.name.toLowerCase()} was done`;
  switch (then.kind) {
    case 'time': return `${on}, ${then.name.toLowerCase()} came earlier — about ${hm(t.withValue)}, against ${hm(t.withoutValue)} on the other days.`;
    case 'min': return `${on}, ${then.name.toLowerCase()} ran longer — about ${dur(t.withValue)}, against ${dur(t.withoutValue)} on the other days.`;
    case 'mood': return `${on}, mood was higher on more of the evenings.`;
    default: return `${on}, ${then.name.toLowerCase()} was done more often than on the other days.`;
  }
}
