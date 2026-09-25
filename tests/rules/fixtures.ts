// Invented habits and histories for the rules tests. Nothing here describes a real routine.
import * as fc from 'fast-check';
import type { Habit, HabitKind, LocalDate, Observation, PlannedReason, TriValue, Weekday } from '../../src/rules/types.ts';
import { addDays } from '../../src/rules/dates.ts';

/** A Monday. */
export const START: LocalDate = '2026-01-05';
export const EVERY_DAY: readonly Weekday[] = [0, 1, 2, 3, 4, 5, 6];

export function habit(p: Partial<Habit> & Pick<Habit, 'id' | 'kind'>): Habit {
  return {
    days: EVERY_DAY,
    asked: 'evening',
    target: {},
    tierHistory: [{ tier: 'focus', from: START }],
    createdOn: START,
    ...p,
  };
}

export const walk = habit({ id: 'walk', kind: 'tri' });
export const read = habit({ id: 'read', kind: 'min', target: { bar: 15, aim: 30 } });
export const rise = habit({ id: 'rise', kind: 'time', target: { band: 420, part: 450 } });
export const reps = habit({ id: 'reps', kind: 'count', target: { bar: 10 } });
export const mood = habit({ id: 'mood', kind: 'mood', tierHistory: [{ tier: 'log', from: START }] });

/** One day of one habit: never answered, an answer, or a planned "not today". */
export type Cell = null | { readonly value: number | TriValue } | { readonly planned: PlannedReason };

/** Observations for one habit, one cell per day starting at `from`. */
export function history(habitId: string, cells: readonly Cell[], from: LocalDate = START): Observation[] {
  const out: Observation[] = [];
  cells.forEach((c, i) => {
    if (c === null) return;
    const date = addDays(from, i);
    out.push('planned' in c ? { habitId, date, planned: c.planned } : { habitId, date, value: c.value });
  });
  return out;
}

/** Shorthand for tri habits: d = did, p = partly, n = not today, . = never answered, r = planned rest. */
export function tri(pattern: string): Cell[] {
  return [...pattern].map(ch =>
    ch === 'd' ? { value: 'did' } : ch === 'p' ? { value: 'partly' } : ch === 'n' ? { value: 'not' }
      : ch === 'r' ? { planned: 'rest' } : null);
}

// ─── generators ───

const arbTri = fc.constantFrom<TriValue>('did', 'partly', 'not');
const arbReason = fc.constantFrom<PlannedReason>('meeting', 'travelling', 'unwell', 'chose', 'rest');

export function arbValue(kind: HabitKind): fc.Arbitrary<number | TriValue> {
  switch (kind) {
    case 'time': return fc.oneof(fc.integer({ min: 300, max: 600 }), fc.constant<TriValue>('not'));
    case 'min': return fc.oneof(fc.integer({ min: 0, max: 200 }), fc.constant<TriValue>('not'));
    case 'count': return fc.oneof(fc.integer({ min: 0, max: 30 }), fc.constant<TriValue>('not'));
    case 'tri': return arbTri;
    case 'mood': return fc.oneof(fc.integer({ min: 1, max: 5 }), fc.constant<TriValue>('not'));
  }
}

export function arbCell(kind: HabitKind): fc.Arbitrary<Cell> {
  return fc.oneof(
    { arbitrary: fc.constant(null), weight: 2 },
    { arbitrary: arbValue(kind).map(value => ({ value })), weight: 6 },
    { arbitrary: arbReason.map(planned => ({ planned })), weight: 1 },
  );
}

const arbKind = fc.constantFrom<HabitKind>('time', 'tri', 'min', 'count', 'mood');

export function arbHabit(id: string, kinds: fc.Arbitrary<HabitKind> = arbKind): fc.Arbitrary<Habit> {
  return fc.record({
    kind: kinds,
    days: fc.subarray([...EVERY_DAY], { minLength: 1 }),
    band: fc.integer({ min: 360, max: 480 }),
    slack: fc.integer({ min: 0, max: 60 }),
    bar: fc.integer({ min: 1, max: 30 }),
    createdAfter: fc.integer({ min: 0, max: 10 }),
    logFrom: fc.option(fc.integer({ min: 1, max: 60 }), { nil: undefined }),
  }).map(r => habit({
    id,
    kind: r.kind,
    days: r.days as Weekday[],
    target: r.kind === 'time' ? { band: r.band, part: r.band + r.slack } : r.kind === 'min' || r.kind === 'count' ? { bar: r.bar } : {},
    createdOn: addDays(START, r.createdAfter),
    tierHistory: r.logFrom === undefined
      ? [{ tier: 'focus', from: START }]
      : [{ tier: 'focus', from: START }, { tier: 'log', from: addDays(START, r.logFrom) }],
  }));
}

/** A habit together with an invented history for it of `days` days. */
export function arbTracked(id: string, days: number, kinds?: fc.Arbitrary<HabitKind>) {
  return arbHabit(id, kinds).chain(h =>
    fc.array(arbCell(h.kind), { minLength: days, maxLength: days }).map(cells => ({ habit: h, cells })));
}
