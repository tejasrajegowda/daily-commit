import type { HabitRecord, Model } from '../record/model.ts';
import { MAX_FOCUS, type HabitChange, type NewHabit } from '../record/ops/habits.ts';
import { askedOn, inPlan, isRetired, scheduleOn, tierOn } from '../rules/state.ts';
import type { Asked, HabitKind, LocalDate, Target, Tier, Weekday } from '../rules/types.ts';

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

/** The line under a habit's name in Plan. */
export function habitLine(h: HabitRecord, today: LocalDate): string {
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
  /** time: "did" at or before this clock time; minutes: the bar and the aim */
  readonly band?: number;
  readonly part?: number;
  readonly bar?: number;
  readonly aim?: number;
}

export const EMPTY_FORM: HabitForm = { name: '', sub: '', kind: 'tri', days: [0, 1, 2, 3, 4, 5, 6], asked: 'evening', tier: 'log' };

export function formOf(h: HabitRecord, today: LocalDate): HabitForm {
  const s = scheduleOn(h, today) ?? h.schedule.at(-1);
  return {
    name: h.name, sub: h.sub ?? '', kind: h.kind, days: s?.days ?? [], asked: s?.asked ?? 'evening',
    tier: tierOn(h, today) ?? 'log', band: h.target.band, part: h.target.part, bar: h.target.bar, aim: h.target.aim,
  };
}

/** What's wrong with the form, in words; empty when it can be saved. */
export function formProblems(f: HabitForm): string[] {
  const out: string[] = [];
  if (!f.name.trim()) out.push('It needs a name.');
  if (f.name.trim().length > 60) out.push('The name is longer than 60 characters.');
  if (f.days.length === 0) out.push('Pick at least one day.');
  if (f.kind === 'time' && f.band !== undefined && f.part !== undefined && f.part < f.band) out.push('"Partly" has to be the same time as "did", or later.');
  if (f.kind === 'min' && f.bar !== undefined && f.bar < 1) out.push('Done needs at least one minute.');
  if (f.kind === 'min' && f.bar !== undefined && f.aim !== undefined && f.aim < f.bar) out.push('The aim is at least the minutes that count as done.');
  if (f.kind === 'count' && f.bar !== undefined && f.bar < 1) out.push('Done needs at least one.');
  return out;
}

function targetOf(f: HabitForm): Target {
  if (f.kind === 'time') return { ...(f.band !== undefined && { band: f.band }), ...(f.part !== undefined && { part: f.part }) };
  if (f.kind === 'min' || f.kind === 'count') return { ...(f.bar !== undefined && { bar: f.bar }), ...(f.aim !== undefined && { aim: f.aim }) };
  return {};
}

/** A new habit from the form; the id is made when the editor opened, so saving twice makes one habit. */
export function newHabitOf(f: HabitForm, id: string): NewHabit {
  return { id, name: f.name.trim(), ...(f.sub.trim() && { sub: f.sub.trim() }), kind: f.kind, days: [...f.days], asked: f.asked, target: targetOf(f), tier: f.tier };
}

/** The change to an existing habit: its kind never changes (B-4); a weekday change starts tomorrow (B-3). */
export function changeOf(f: HabitForm, h: HabitRecord): HabitChange {
  return { id: h.id, name: f.name.trim(), sub: f.sub.trim(), target: targetOf({ ...f, kind: h.kind }), days: [...f.days], asked: f.asked };
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
} as const;
