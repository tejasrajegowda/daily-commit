import type { HabitRecord, Model } from '../record/model.ts';
import { restMarks } from '../record/mapping.ts';
import { MAX_FOCUS, type HabitChange, type NewHabit } from '../record/ops/habits.ts';
import { clockOfDay, DEFAULT_BOUNDARY, toDayMinute } from '../rules/clock.ts';
import { addDays } from '../rules/dates.ts';
import { restDaysLeft } from '../rules/rest.ts';
import { askedOn, inPlan, isAsked, isRetired, scheduleOn, tierOn } from '../rules/state.ts';
import type { Asked, ClockMinute, HabitKind, LocalDate, PlannedReason, ScheduleEntry, Target, Tier, Weekday } from '../rules/types.ts';

// Plan, the back of house: Focus as three slots you can see, Log beside it, and the editor's form.
// The form is checked here, before any save, so the screen can say what's missing in words.

const LETTERS = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];

export function kindText(kind: HabitKind): string {
  return kind === 'time' ? 'a time' : kind === 'min' ? 'minutes' : kind === 'mood' ? '1 to 5' : kind === 'count' ? 'a count' : 'did · partly · not';
}

export function daysText(days: readonly Weekday[]): string {
  const key = [...days].sort().join('');
  if (key === '0123456') return 'every day';
  if (key === '01234') return 'Mon–Fri';
  if (key === '56') return 'weekends';
  return [...days].sort().map(d => LETTERS[d]).join(' ');
}

/**
 * The schedule a weekday/asked change is pending for: the entry that starts tomorrow, when today
 * already has a value and B-3 holds the change back a day (`ops/habits.ts`, `editHabit`).
 */
function pendingSchedule(h: HabitRecord, today: LocalDate): ScheduleEntry | undefined {
  const tomorrow = scheduleOn(h, addDays(today, 1));
  return tomorrow !== undefined && tomorrow !== scheduleOn(h, today) ? tomorrow : undefined;
}

/** The line under a habit's name in Plan. */
export function habitLine(h: HabitRecord, today: LocalDate): string {
  const pending = pendingSchedule(h, today);
  if (pending) return `${kindText(h.kind)} · ${daysText(pending.days)} · ${pending.asked} · from tomorrow`;
  const days = scheduleOn(h, today)?.days ?? h.schedule.at(-1)?.days ?? [];
  const asked = askedOn(h, today) ?? h.schedule.at(-1)?.asked ?? 'evening';
  return `${kindText(h.kind)} · ${daysText(days)} · ${asked}`;
}

export interface PlanLists {
  /** three slots, in order; undefined is an empty slot */
  readonly focus: readonly (HabitRecord | undefined)[];
  readonly log: readonly HabitRecord[];
  readonly retired: readonly HabitRecord[];
}

export function planLists(model: Model, today: LocalDate): PlanLists {
  const all = [...model.habits.values()].sort((a, b) => a.order - b.order);
  const live = all.filter(h => !isRetired(h) || inPlan(h, today));
  const focus = live.filter(h => tierOn(h, today) === 'focus');
  return {
    focus: Array.from({ length: MAX_FOCUS }, (_, i) => focus[i]),
    log: live.filter(h => tierOn(h, today) !== 'focus'),
    retired: all.filter(h => isRetired(h) && !inPlan(h, today)),
  };
}

export const slotNote = (filled: number) => (filled >= MAX_FOCUS
  ? 'Full. To bring something new in, choose which of these graduates to Log — it keeps every day of its history.'
  : 'A slot is free. Something new can start in Log first, and move to Focus once it feels steady.');

/** The editor's form, as typed. */
export interface HabitForm {
  readonly name: string;
  readonly sub: string;
  readonly kind: HabitKind;
  readonly days: readonly Weekday[];
  readonly asked: Asked;
  readonly tier: Tier;
  /**
   * time: "did" at or before this clock time, "partly" at or before the second. Typed and shown as
   * clock times; stored as DayMinutes, so for a habit asked at night 00:30 is kept as 1470.
   */
  readonly band?: number;
  readonly part?: number;
  readonly bar?: number;
  readonly aim?: number;
  /** true when `days`/`asked` are a pending change that starts tomorrow, not what is in force today */
  readonly fromTomorrow?: boolean;
}

export const EMPTY_FORM: HabitForm = { name: '', sub: '', kind: 'tri', days: [0, 1, 2, 3, 4, 5, 6], asked: 'evening', tier: 'log' };

const clockOf = (m: number | undefined) => (m === undefined ? undefined : clockOfDay(m));

/** The form's band and partly as the record keeps them: on the day they are asked for, as Today stores a time. */
function dayMinutesOf(f: HabitForm, boundary: ClockMinute) {
  const at = (m: number | undefined) => (m === undefined ? undefined : toDayMinute(m, f.asked, boundary));
  return { band: at(f.band), part: at(f.part) };
}

export function formOf(h: HabitRecord, today: LocalDate): HabitForm {
  const pending = pendingSchedule(h, today);
  const s = pending ?? scheduleOn(h, today) ?? h.schedule.at(-1);
  return {
    name: h.name, sub: h.sub ?? '', kind: h.kind, days: s?.days ?? [], asked: s?.asked ?? 'evening',
    tier: tierOn(h, today) ?? 'log', band: clockOf(h.target.band), part: clockOf(h.target.part), bar: h.target.bar, aim: h.target.aim,
    ...(pending && { fromTomorrow: true }),
  };
}

/** What's wrong with the form, in words; empty when it can be saved. */
export function formProblems(f: HabitForm, boundary: ClockMinute = DEFAULT_BOUNDARY): string[] {
  const out: string[] = [];
  const t = dayMinutesOf(f, boundary);
  if (!f.name.trim()) out.push('It needs a name.');
  if (f.name.trim().length > 60) out.push('The name is longer than 60 characters.');
  if (f.days.length === 0) out.push('Pick at least one day.');
  if (f.kind === 'time' && t.band !== undefined && t.part !== undefined && t.part < t.band) out.push('The time for partly has to be the same as the time for done, or later.');
  if (f.kind === 'min' && f.bar !== undefined && f.bar < 1) out.push('Done needs at least one minute.');
  if (f.kind === 'min' && f.bar !== undefined && f.aim !== undefined && f.aim < f.bar) out.push('The aim is at least the minutes that count as done.');
  if (f.kind === 'count' && f.bar !== undefined && f.bar < 1) out.push('Done needs at least one.');
  return out;
}

function targetOf(f: HabitForm, boundary: ClockMinute): Target {
  if (f.kind === 'time') {
    const { band, part } = dayMinutesOf(f, boundary);
    return { ...(band !== undefined && { band }), ...(part !== undefined && { part }) };
  }
  if (f.kind === 'min' || f.kind === 'count') return { ...(f.bar !== undefined && { bar: f.bar }), ...(f.aim !== undefined && { aim: f.aim }) };
  return {};
}

/** A new habit from the form; the id is made when the editor opened, so saving twice makes one habit. */
export function newHabitOf(f: HabitForm, id: string, boundary: ClockMinute = DEFAULT_BOUNDARY): NewHabit {
  return { id, name: f.name.trim(), ...(f.sub.trim() && { sub: f.sub.trim() }), kind: f.kind, days: [...f.days], asked: f.asked, target: targetOf(f, boundary), tier: f.tier };
}

/** The change to an existing habit: its kind never changes (B-4); a weekday change starts tomorrow (B-3). */
export function changeOf(f: HabitForm, h: HabitRecord, boundary: ClockMinute = DEFAULT_BOUNDARY): HabitChange {
  return { id: h.id, name: f.name.trim(), sub: f.sub.trim(), target: targetOf({ ...f, kind: h.kind }, boundary), days: [...f.days], asked: f.asked };
}

export const PLAN_WORDS = {
  intro: 'Back of house. Changed on Sundays, not every day.',
  recorded: 'The raw thing is stored — a time, or minutes — never a yes or no. Targets can change later without rewriting the past.',
  focus: 'Focus is scored and holds three.',
  log: 'Log is kept and never scored.',
  privateOn: 'The words stay locked with your diary.',
  privateOff: 'Without it, the words appear in the notification, and Android keeps them in its notification history.',
  nudge: 'A reminder only nudges: it asks nothing, is never repeated, and stays quiet between lights out and waking.',
  retire: 'Every day it was logged stays in Look back.',
  backInLog: 'Focus is full, so it came back into Log. It can move to Focus once a slot is free.',
  fromTomorrow: 'Today already has a value, so this starts tomorrow. Today keeps the days it was logged under.',
} as const;

/** How far ahead Plan offers days: tomorrow and the thirteen after it. */
export const DAYS_AHEAD = 14;

export interface DayAhead {
  readonly date: LocalDate;
  /** the whole day is a rest day */
  readonly rest: boolean;
  /** one-habit plans made for it, and whether each keeps its habit's run */
  readonly plans: readonly { readonly habitId: string; readonly reason: PlannedReason; readonly keepsRun: boolean }[];
  /** the day already uses one of its month's two */
  readonly counted: boolean;
  /** rest days left in its month */
  readonly left: number;
}

/** The days Plan can plan ahead (D-30, D-31): from tomorrow, each with what is already planned on it. */
export function daysAhead(model: Model, today: LocalDate, count: number = DAYS_AHEAD): DayAhead[] {
  const marks = restMarks(model);
  return Array.from({ length: count }, (_, i) => {
    const date = addDays(today, i + 1);
    const plans = [...model.observations.values()]
      .filter(o => o.date === date && o.planned !== undefined && o.value === undefined)
      .sort((a, b) => (model.habits.get(a.habitId)?.order ?? 0) - (model.habits.get(b.habitId)?.order ?? 0))
      .map(o => ({ habitId: o.habitId, reason: o.planned as PlannedReason, keepsRun: o.keepsRun === true }));
    return { date, rest: model.days.get(date)?.restDay === true, plans, counted: marks.includes(date), left: restDaysLeft(marks, date) };
  });
}

/** What the days-ahead sheet says about the month's two rest days. Plain, and nothing about losing. */
export function aheadWords(day: Pick<DayAhead, 'left' | 'counted'>, month: string): string {
  if (day.counted) return `This day is one of ${month}'s two rest days. A run carries on through it.`;
  if (day.left > 1) return `Two rest days are free in ${month}. A run carries on through them.`;
  if (day.left === 1) return `One rest day is free in ${month}. A run carries on through it.`;
  return `${month}'s two rest days are planned. A habit can still be marked off here: its reminder stays quiet and the day is kept as planned. Runs carry on through the month's two only.`;
}

/** The Focus habits asked on a day: the ones a day ahead can mark off one at a time. */
export function focusOn(model: Model, date: LocalDate): HabitRecord[] {
  return [...model.habits.values()].filter(h => isAsked(h, date) && tierOn(h, date) === 'focus').sort((a, b) => a.order - b.order);
}

const words = (date: LocalDate, o: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat('en-GB', { ...o, timeZone: 'UTC' }).format(new Date(`${date}T00:00:00Z`));
/** A day ahead in a list: "Friday 23 January". */
export const aheadLabel = (date: LocalDate) => words(date, { weekday: 'long', day: 'numeric', month: 'long' });
/** A day ahead as a small choice: "Fri 23". */
export const aheadChip = (date: LocalDate) => words(date, { weekday: 'short', day: 'numeric' });
/** A day's month, by name. */
export const monthOf = (date: LocalDate) => words(date, { month: 'long' });
