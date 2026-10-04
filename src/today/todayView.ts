import type { HabitRecord, Model } from '../record/model.ts';
import type { RulesInput } from '../record/read.ts';
import { clockOfDay } from '../rules/clock.ts';
import { blockAt, stepsAround, type DayShape } from '../rules/dayLine.ts';
import { dayNumber } from '../rules/journey.ts';
import { restDaysLeft, restOffered } from '../rules/rest.ts';
import { askedOn, isAsked, lookup, stateOf, tierOn } from '../rules/state.ts';
import type { ClockMinute, DayState, HabitKind, LocalDate, PlannedReason, TriValue } from '../rules/types.ts';

// What Today shows, worked out from the record: which part of the day it is, which rows, in which
// order, and whether a rest day is offered. Only today: the morning screen holds nothing from any
// day before it (invariant 4).

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
  /** evening: Focus answered, drawn as chips */
  readonly earlier: readonly TodayRow[];
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

  let key = 0;
  const keyed = (list: readonly TodayRow[]) => list.map(r => ({ ...strip(r), key: ++key <= 9 ? key : undefined }));
  const morningRows = part === 'morning' ? keyed([...focus, ...log.filter(r => r.asked === 'morning')]) : [];
  const eveningRows = keyed(log.filter(r => r.asked === 'evening'));
  const openFocus = part === 'evening' ? keyed(focus.filter(r => !answered(r))) : [];
  const earlier = part === 'evening' ? focus.filter(answered).map(strip) : [];
  const restDays = [...model.days.values()].filter(d => d.restDay).map(d => d.date);
  const left = restDaysLeft(restDays, today, model.settings.journeyStart);
  return {
    part, dayNumber: dayNumber(model.settings.journeyStart, today),
    morningRows, eveningRows, openFocus, earlier,
    restOffer: !day?.restDay && restOffered({ evening: part === 'evening', openFocus: openFocus.length, left }),
    closedAt: day?.closedAt, intent: day?.intent, remark: day?.remark,
  };
}

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

/** The sky's two lines: where you are in the day, and what comes next. */
export function skyWords(shape: DayShape, t: ClockMinute, boundary: ClockMinute): readonly [string, string] {
  const first = shape.steps[0];
  if (t >= shape.lightsOut || t < boundary) return ['Lights out', first ? `Tomorrow starts at ${hm(first.at)}` : 'Tomorrow is a new day'];
  const { current, next } = stepsAround(shape, t);
  if (!current || t < shape.window.from) return ['Before the day', next ? `${next.label} at ${hm(next.at)}` : ''];
  const where = blockAt(shape, t)?.label ?? current.label;
  return [where, next ? `${next.label} at ${hm(next.at)}` : `Yours until ${hm(shape.lightsOut)}`];
}
