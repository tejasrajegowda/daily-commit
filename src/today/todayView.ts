import type { HabitRecord, Model } from '../record/model.ts';
import type { RulesInput } from '../record/read.ts';
import { clockOfDay } from '../rules/clock.ts';
import { addDays } from '../rules/dates.ts';
import { blockAt, stepsAround, type DayShape } from '../rules/dayLine.ts';
import { dayNumber } from '../rules/journey.ts';
import { restDaysLeft, restOffered } from '../rules/rest.ts';
import { askedOn, isAsked, lookup, stateOf, tierOn } from '../rules/state.ts';
import type { ClockMinute, DayState, HabitKind, LocalDate, PlannedReason, TriValue } from '../rules/types.ts';

// What Today shows, worked out from the record: which part of the day it is, which rows, in which
// order, and whether a rest day is offered. Only today: the morning screen holds nothing from any
// day before it (invariant 4). The one look forward: between midnight and the boundary, the day
// ahead's morning time rows (a wake-up), which belong to that day (B-5).

/** Today switches from the morning screen to the evening one at 14:00. */
export const EVENING_FROM = 840;

export interface TodayRow {
  readonly habit: HabitRecord;
  /** in Focus today */
  readonly focus: boolean;
  /** when it is asked today */
  readonly asked: 'morning' | 'evening';
  readonly state: DayState;
  readonly value?: number | TriValue;
  readonly planned?: PlannedReason;
  /** the laptop key that marks it, 1–9, in drawn order */
  readonly key?: number;
}

export interface TodayView {
  readonly part: 'morning' | 'evening' | 'closed';
  readonly dayNumber: number;
  /** morning: Focus, then Log asked in the morning */
  readonly morningRows: readonly TodayRow[];
  /** Log asked in the evening */
  readonly eveningRows: readonly TodayRow[];
  /** evening: Focus not answered yet */
  readonly openFocus: readonly TodayRow[];
  /** evening: Focus answered or planned, drawn as chips; a tap opens the row again */
  readonly earlier: readonly TodayRow[];
  /** between midnight and the boundary: the day ahead's time rows asked in the morning, for a wake-up */
  readonly ahead: readonly TodayRow[];
  readonly restOffer: boolean;
  readonly closedAt?: number;
  readonly intent?: string;
  readonly remark?: string;
}

const answered = (r: TodayRow) => r.value !== undefined || r.planned !== undefined;

export function todayView(input: RulesInput, model: Model, today: LocalDate, clockMinute: ClockMinute): TodayView {
  const day = model.days.get(today);
  const rows = [...input.habits]
    .filter(h => isAsked(h, today))
    .sort((a, b) => a.order - b.order)
    .map((habit): TodayRow => {
      const obs = lookup(input.index, habit.id, today);
      return {
        habit, focus: tierOn(habit, today) === 'focus', asked: askedOn(habit, today) ?? 'evening',
        state: stateOf(habit, obs, today), value: obs?.value, planned: obs?.planned,
      };
    });
  const focus = rows.filter(r => r.focus);
  const log = rows.filter(r => !r.focus);
  const boundary = model.settings.boundary;
  const part = day?.closedAt !== undefined ? 'closed' : clockMinute >= boundary && clockMinute < EVENING_FROM ? 'morning' : 'evening';
  const strip = (r: TodayRow): TodayRow => ({ habit: r.habit, focus: r.focus, asked: r.asked, state: r.state, value: r.value, planned: r.planned });
  const next = addDays(today, 1);
  const wakes = clockMinute < boundary
    ? [...input.habits]
      .filter(h => h.kind === 'time' && isAsked(h, next) && askedOn(h, next) === 'morning')
      .sort((a, b) => a.order - b.order)
      .map((habit): TodayRow => {
        const obs = lookup(input.index, habit.id, next);
        return { habit, focus: tierOn(habit, next) === 'focus', asked: 'morning', state: stateOf(habit, obs, next), value: obs?.value, planned: obs?.planned };
      })
    : [];

  let key = 0;
  const keyed = (list: readonly TodayRow[]) => list.map(r => ({ ...strip(r), key: ++key <= 9 ? key : undefined }));
  // drawn first, so keyed first
  const ahead = keyed(wakes);
  const morningRows = part === 'morning' ? keyed([...focus, ...log.filter(r => r.asked === 'morning')]) : [];
  const eveningRows = keyed(log.filter(r => r.asked === 'evening'));
  const openFocus = part === 'evening' ? keyed(focus.filter(r => !answered(r))) : [];
  const earlier = part === 'evening' ? keyed(focus.filter(answered)) : [];
  const restDays = [...model.days.values()].filter(d => d.restDay).map(d => d.date);
  const left = restDaysLeft(restDays, today, model.settings.journeyStart);
  return {
    part, dayNumber: dayNumber(model.settings.journeyStart, today),
    morningRows, eveningRows, openFocus, earlier, ahead,
    restOffer: !day?.restDay && restOffered({ evening: part === 'evening', openFocus: openFocus.length, left }),
    closedAt: day?.closedAt, intent: day?.intent, remark: day?.remark,
  };
}

/**
 * Whether a time row asks for its time instead of taking the clock's. In the evening the clock is
 * almost never a morning time, and a planned row answered after all wasn't done just now.
 */
export function asksForTime(row: TodayRow, part: TodayView['part']): boolean {
  return row.habit.kind === 'time' && part === 'evening' && (row.asked === 'morning' || row.planned !== undefined);
}

/**
 * Whether a time typed into tonight's empty morning row is really a wake-up that has just happened:
 * between midnight and the boundary, a time before the boundary and not later than now. It goes to
 * the day ahead (B-5), never to the day before.
 */
export function wakesAhead(clock: ClockMinute, t: ClockMinute, boundary: ClockMinute): boolean {
  return t < boundary && clock < boundary && clock <= t;
}

/** "07:05" as a clock minute; undefined for anything else. */
export const fromHm = (s: string) => { const m = /^(\d{1,2}):(\d{2})$/.exec(s); return m ? Number(m[1]) * 60 + Number(m[2]) : undefined; };

export const hm = (minute: number) => {
  const m = Math.round(minute);
  return `${String(Math.floor(m / 60) % 24).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
};

export const dur = (minutes: number) => {
  const h = Math.floor(minutes / 60), r = minutes % 60;
  return h ? (r ? `${h}h ${r}m` : `${h}h`) : `${r}m`;
};

/** A row's value as it is written beside it. */
export function valueText(kind: HabitKind, value: number | TriValue | undefined): string {
  if (value === undefined) return '';
  if (typeof value === 'string') return value === 'partly' ? 'partly' : value === 'not' ? 'not today' : '';
  if (kind === 'time') return hm(clockOfDay(value));
  if (kind === 'min') return dur(value);
  return String(value);
}

/** The shape list's rows, each with its end, closing on lights out; a step already at that minute
 *  stands for it, so it is never listed twice. */
export function shapeRows(shape: DayShape): readonly { at: number; end: number; label: string }[] {
  const rows = shape.steps.map((s, i) => ({ at: s.at, label: s.label, end: shape.steps[i + 1]?.at ?? shape.lightsOut }));
  const last = rows.at(-1);
  if (last && last.at >= shape.lightsOut) return [...rows.slice(0, -1), { ...last, end: 1440 }];
  return [...rows, { at: shape.lightsOut, end: 1440, label: 'Lights out' }];
}

/** The sky's two lines: where you are in the day, and what comes next. */
export function skyWords(shape: DayShape, t: ClockMinute, boundary: ClockMinute): readonly [string, string] {
  const first = shape.steps[0];
  if (t >= shape.lightsOut || t < boundary) return ['Lights out', first ? `Tomorrow starts at ${hm(first.at)}` : 'Tomorrow is a new day'];
  const { current, next } = stepsAround(shape, t);
  if (!current || t < shape.window.from) return ['Before the day', next ? `${next.label} at ${hm(next.at)}` : ''];
  const where = blockAt(shape, t)?.label ?? current.label;
  return [where, next ? `${next.label} at ${hm(next.at)}` : `Yours until ${hm(shape.lightsOut)}`];
}
