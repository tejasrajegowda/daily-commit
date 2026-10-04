import type { Asked, HabitKind, LocalDate, ScheduleEntry, Target, Tier, TierPeriod, Weekday } from '../../rules/types.ts';
import type { Cue, CueTimes } from '../../rules/cues.ts';
import { addDays } from '../../rules/dates.ts';
import { inPlan, isRetired, scheduleOn, tierOn } from '../../rules/state.ts';
import type { Put, RecordCore } from '../core.ts';
import type { CueRecord, HabitRecord, Model } from '../model.ts';
import { cueToParts, defined, habitToParts } from '../mapping.ts';
import { invalid, type Refusal, type Result } from '../results.ts';
import type { Sheet } from '../time.ts';
import { cueProblem, habitProblem } from '../validate.ts';
import { judgedNow, storedRow } from './common.ts';

// Making and changing habits. A habit's time in the plan, its weekdays and its tier are kept as
// history, so a change never rewrites a day already past. A habit's kind never changes.

export const MAX_FOCUS = 3;

/** A reminder made together with its habit. */
export interface CueInput {
  /** made when the sheet opened, so saving twice makes one reminder */
  readonly id: string;
  readonly text: string;
  readonly times: CueTimes;
  readonly fade?: Cue['fade'];
  readonly private: boolean;
}

export interface NewHabit {
  /** made when the sheet opened, so saving twice makes one habit */
  readonly id: string;
  readonly name: string;
  readonly sub?: string;
  readonly kind: HabitKind;
  readonly days: readonly Weekday[];
  readonly asked: Asked;
  readonly target: Target;
  readonly tier: Tier;
  /** the first day it is part of the plan, when history from before today is brought in */
  readonly startedOn?: LocalDate;
  readonly replaces?: string;
  readonly cues?: readonly CueInput[];
  readonly sheet?: Sheet;
}

export interface HabitChange {
  readonly id: string;
  readonly name?: string;
  readonly sub?: string;
  readonly target?: Target;
  readonly order?: number;
  readonly days?: readonly Weekday[];
  readonly asked?: Asked;
  /** moves the first day earlier, for history brought in */
  readonly startedOn?: LocalDate;
  readonly sheet?: Sheet;
}

const byNumber = (a: number, b: number) => a - b;
const sameTier = (a: TierPeriod, b: TierPeriod) => a.tier === b.tier;
const sameSchedule = (a: ScheduleEntry, b: ScheduleEntry) => a.asked === b.asked && a.days.join() === b.days.join();

/**
 * A history with `next` in force from its day: entries from that day on are replaced, and if the
 * entry before already says the same, nothing new is added.
 */
function withEntry<T extends { readonly from: LocalDate }>(history: readonly T[], next: T, same: (a: T, b: T) => boolean): T[] {
  const kept = history.filter(e => e.from < next.from);
  const before = kept.at(-1);
  return before && same(before, next) ? kept : [...kept, next];
}

/** Moves a history's first entry back to `day` if it starts later. */
function startEarlier<T extends { readonly from: LocalDate }>(history: readonly T[], day: LocalDate): T[] {
  return history.map((e, i) => (i === 0 && e.from > day ? { ...e, from: day } : e));
}

/** How many habits are in the plan and in Focus on a day. */
function focusCount(habits: Iterable<HabitRecord>, day: LocalDate): number {
  let n = 0;
  for (const h of habits) if (inPlan(h, day) && tierOn(h, day) === 'focus') n++;
  return n;
}

/** Refuses a change that would put more than three habits in Focus on any day from `from` to `today`. */
function tooManyInFocus(model: Model, changed: HabitRecord, from: LocalDate, today: LocalDate): Refusal | undefined {
  const after = new Map(model.habits);
  after.set(changed.id, changed);
  for (let day = from; day <= today; day = addDays(day, 1)) {
    if (focusCount(after.values(), day) > MAX_FOCUS) return invalid('three habits are in Focus already');
  }
  return undefined;
}

/** One habit changed by `change`, checked and stored. */
function changeHabit(
  core: RecordCore, id: string, sheet: Sheet | undefined,
  change: (h: HabitRecord, today: LocalDate, model: Model) => HabitRecord | Refusal,
): Promise<Result<void>> {
  return core.write({
    tables: ['habits'],
    async prepare(s, stamp) {
      const h = s.model.habits.get(id);
      if (!h) return invalid('no such habit');
      const next = change(h, judgedNow(core, s, sheet).today, s.model);
      if (!('id' in next)) return next;
      const problem = habitProblem(next, s.model.settings.boundary);
      if (problem) return invalid(problem);
      return {
        puts: [{ table: 'habits', row: await storedRow(s.cipher, 'habits', habitToParts(next), stamp) }],
        apply: m => { m.habits.set(next.id, next); },
        value: undefined,
      };
    },
  });
}

export function createHabit(core: RecordCore, input: NewHabit): Promise<Result<void>> {
  return core.write({
    tables: ['habits', 'cues'],
    async prepare(s, stamp) {
      const { today } = judgedNow(core, s, input.sheet);
      const from = input.startedOn ?? today;
      if (from > today) return invalid('a habit cannot start in the future');
      const others = [...s.model.habits.values()].filter(h => h.id !== input.id);
      const habit: HabitRecord = defined({
        id: input.id, name: input.name.trim(), sub: input.sub, kind: input.kind,
        periods: [{ from }], schedule: [{ from, days: [...input.days].sort(byNumber), asked: input.asked }],
        target: input.target, tierHistory: [{ tier: input.tier, from }],
        order: s.model.habits.get(input.id)?.order ?? Math.max(-1, ...others.map(h => h.order)) + 1,
        replaces: input.replaces,
      });
      const problem = habitProblem(habit, s.model.settings.boundary);
      if (problem) return invalid(problem);
      const crowded = input.tier === 'focus' ? tooManyInFocus(s.model, habit, from, today) : undefined;
      if (crowded) return crowded;
      const cues: CueRecord[] = (input.cues ?? []).map(c => defined({
        id: c.id, habitId: input.id, kind: 'cue' as const, text: c.text, times: c.times, fade: c.fade,
        enabled: true, createdOn: s.model.cues.get(c.id)?.createdOn ?? today, private: c.private,
      }));
      for (const c of cues) {
        const cueBad = cueProblem(c, s.model.settings.boundary);
        if (cueBad) return invalid(cueBad);
      }
      const puts: Put[] = [
        { table: 'habits', row: await storedRow(s.cipher, 'habits', habitToParts(habit), stamp) },
        ...(await Promise.all(cues.map(async (c): Promise<Put> => ({ table: 'cues', row: await storedRow(s.cipher, 'cues', cueToParts(c), stamp) })))),
      ];
      return {
        puts,
        apply: m => {
          m.habits.set(habit.id, habit);
          for (const c of cues) m.cues.set(c.id, c);
        },
        value: undefined,
      };
    },
  });
}

export function editHabit(core: RecordCore, change: HabitChange): Promise<Result<void>> {
  return changeHabit(core, change.id, change.sheet, (h, today, model) => {
    let schedule: ScheduleEntry[] = [...h.schedule];
    if (change.days !== undefined || change.asked !== undefined) {
      const current = scheduleOn(h, today) ?? h.schedule.at(-1);
      // a day already logged keeps the weekdays it was logged under: the change starts tomorrow
      const from = model.observations.get(`${h.id}|${today}`)?.value !== undefined ? addDays(today, 1) : today;
      const days = [...(change.days ?? current?.days ?? [])].sort(byNumber);
      schedule = withEntry(h.schedule, { from, days, asked: change.asked ?? current?.asked ?? 'evening' }, sameSchedule);
    }
    let periods = [...h.periods];
    let tierHistory = [...h.tierHistory];
    if (change.startedOn !== undefined) {
      if (change.startedOn > (h.periods[0]?.from ?? today)) return invalid('the first day can only move earlier');
      periods = startEarlier(periods, change.startedOn);
      schedule = startEarlier(schedule, change.startedOn);
      tierHistory = startEarlier(tierHistory, change.startedOn);
    }
    const next = defined({
      ...h, name: change.name?.trim() ?? h.name, sub: change.sub ?? h.sub, target: change.target ?? h.target,
      order: change.order ?? h.order, periods, schedule, tierHistory,
    });
    return change.startedOn !== undefined ? tooManyInFocus(model, next, change.startedOn, today) ?? next : next;
  });
}

export function retireHabit(core: RecordCore, input: { readonly id: string; readonly sheet?: Sheet }): Promise<Result<void>> {
  return changeHabit(core, input.id, input.sheet, (h, today) => {
    const last = h.periods.at(-1);
    if (!last || last.until !== undefined) return invalid('already retired');
    // today stays part of the plan, so a log made today still counts
    return { ...h, periods: [...h.periods.slice(0, -1), { from: last.from, until: addDays(today, 1) }] };
  });
}

export function returnHabit(core: RecordCore, input: { readonly id: string; readonly sheet?: Sheet }): Promise<Result<void>> {
  return changeHabit(core, input.id, input.sheet, (h, today, model) => {
    const last = h.periods.at(-1);
    if (!last || last.until === undefined) return invalid('not retired');
    // back before a day was missed: the retire is simply undone
    const next: HabitRecord = last.until >= today
      ? { ...h, periods: [...h.periods.slice(0, -1), { from: last.from }] }
      : { ...h, periods: [...h.periods, { from: today }] };
    return tooManyInFocus(model, next, today, today) ?? next;
  });
}

/**
 * Takes the offer to stop asking (§8 #30): the habit settles into Log from tomorrow, keeping every
 * day it was logged, and its Focus slot is free. A habit already settled is left as it is.
 */
export function settleHabit(core: RecordCore, input: { readonly id: string; readonly sheet?: Sheet }): Promise<Result<void>> {
  return core.write({
    tables: ['habits'],
    async prepare(s, stamp) {
      const h = s.model.habits.get(input.id);
      if (!h) return invalid('no such habit');
      if (h.settledAt !== undefined) return { puts: [], apply: () => {}, value: undefined };
      const tomorrow = addDays(judgedNow(core, s, input.sheet).today, 1);
      const next: HabitRecord = { ...h, settledAt: stamp.updated_at, tierHistory: withEntry(h.tierHistory, { tier: 'log', from: tomorrow }, sameTier) };
      const problem = habitProblem(next, s.model.settings.boundary);
      if (problem) return invalid(problem);
      return {
        puts: [{ table: 'habits', row: await storedRow(s.cipher, 'habits', habitToParts(next), stamp) }],
        apply: m => { m.habits.set(next.id, next); },
        value: undefined,
      };
    },
  });
}

export function swapFocus(core: RecordCore, input: { readonly into?: string; readonly out?: string; readonly sheet?: Sheet }): Promise<Result<void>> {
  return core.write({
    tables: ['habits'],
    async prepare(s, stamp) {
      if (input.into === undefined && input.out === undefined) return invalid('nothing to move');
      const { today } = judgedNow(core, s, input.sheet);
      const changed = new Map<string, HabitRecord>();
      for (const [id, tier] of [[input.out, 'log'], [input.into, 'focus']] as const) {
        if (id === undefined) continue;
        const h = s.model.habits.get(id);
        if (!h || isRetired(h)) return invalid('no such habit in the plan');
        changed.set(id, { ...h, tierHistory: withEntry(h.tierHistory, { tier, from: today }, sameTier) });
      }
      const after = new Map(s.model.habits);
      for (const [id, h] of changed) after.set(id, h);
      if (focusCount(after.values(), today) > MAX_FOCUS) return invalid('three habits are in Focus already');
      const puts = await Promise.all([...changed.values()].map(async (h): Promise<Put> =>
        ({ table: 'habits', row: await storedRow(s.cipher, 'habits', habitToParts(h), stamp) })));
      return { puts, apply: m => { for (const [id, h] of changed) m.habits.set(id, h); }, value: undefined };
    },
  });
}
