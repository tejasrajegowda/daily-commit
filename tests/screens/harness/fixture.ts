// A record handed in from outside: the screenshot comparison sets `window.harnessFixture` before the page
// loads (scripts/screens/compare.mjs), and the harness draws that record instead of its own. The data lives
// outside this repo and is never built into dist-harness/; this file only knows its shape.
import type { RecordDb } from '../../../src/record/db.ts';
import { dayToParts, entryToParts, notYetToParts, observationToParts } from '../../../src/record/mapping.ts';
import type { DayRecord, ObservationRecord, Settings } from '../../../src/record/model.ts';
import { storedRow } from '../../../src/record/ops/common.ts';
import { closeDay, saveDayWords } from '../../../src/record/ops/days.ts';
import { createHabit, type NewHabit } from '../../../src/record/ops/habits.ts';
import { logObservation } from '../../../src/record/ops/observations.ts';
import type { PlannedReason, Tier, TriValue, Weekday } from '../../../src/rules/types.ts';
import { HARNESS_SETTINGS, reopen, startRecord, type Seeded } from './seed.ts';
import { dateOfDay, nowOf, type HarnessState } from './state.ts';

export interface FixtureHabit extends Omit<NewHabit, 'startedOn' | 'sheet' | 'tier'> {
  readonly tier: Tier;
  /** the first day it is part of the plan */
  readonly startDay: number;
  /** a later tier, from that day on; the record is drawn with the tier of the state's day */
  readonly tierFrom?: { readonly day: number; readonly tier: Tier };
}

/** One finished day, day 1 first. A day never opened has no values. */
export interface FixtureDay {
  readonly opened: boolean;
  readonly values: Readonly<Record<string, number | TriValue>>;
  readonly planned: Readonly<Record<string, PlannedReason>>;
  readonly lightsOut?: number;
}

/** Something that happens today at a minute: a habit logged, the intent or remark written, or the day closed. */
export interface FixtureEvent {
  readonly at: number;
  readonly id: string;
  readonly v: number | string;
}

export interface HarnessFixture {
  /** the date of day 1 */
  readonly start: string;
  readonly settings: Partial<Pick<Settings, 'wakePlan' | 'lightsOutPlan' | 'dayShapes'>>;
  readonly habits: readonly FixtureHabit[];
  readonly history: readonly FixtureDay[];
  /** today's events by day number, with `17` as the default and `hard` for the hard-day variant */
  readonly today: Readonly<Record<string, readonly FixtureEvent[]>>;
  /** diary pages and Not yet items, each written on a date at a minute */
  readonly entries: readonly { readonly date: string; readonly at: number; readonly body: string }[];
  readonly notyet: readonly { readonly date: string; readonly at: number; readonly text: string }[];
}

declare global {
  interface Window { harnessFixture?: HarnessFixture }
}

const weekdayOf = (date: string) => ((new Date(`${date}T00:00:00Z`).getUTCDay() + 6) % 7) as Weekday;
const at = (date: string, minute: number) => Date.parse(`${date}T00:00:00Z`) + minute * 60_000;

/** An id the app reads its written time from (a version-7 UUID's leading milliseconds). */
export function idWrittenAt(ms: number, n: number): string {
  const t = ms.toString(16).padStart(12, '0');
  return `${t.slice(0, 8)}-${t.slice(8, 12)}-7000-8000-${n.toString(16).padStart(12, '0')}`;
}

/** First run, the habits as of the state's day, the finished days before it, today up to the state's minute. */
export async function seedFixture(db: RecordDb, state: HarnessState, fx: HarnessFixture): Promise<Seeded> {
  // set up at the day's start (04:00), so today's events, stamped later, keep their own minutes: a change stamp
  // never goes back before the newest one stored
  const started = await startRecord(db, { ...state, minute: Math.min(state.minute, 240) }, { ...HARNESS_SETTINGS, ...fx.settings, journeyStart: fx.start });
  const { core, cipher, stamp, clock } = started;
  const day = (d: number) => dateOfDay(d, fx.start);
  const today = day(state.day);
  const now = nowOf(state);
  const habits = fx.habits.filter(h => h.startDay <= state.day);
  for (const { startDay, tierFrom, ...h } of habits) {
    const tier = tierFrom && state.day >= tierFrom.day ? tierFrom.tier : h.tier;
    const made = await createHabit(core, { ...h, tier, startedOn: day(startDay) });
    if (made.kind !== 'Saved') throw new Error(`fixture habit ${h.id}: ${made.kind}`);
  }

  const observations: object[] = [];
  const days: object[] = [];
  for (let d = 1; d < state.day; d++) {
    const past = fx.history[d - 1];
    if (!past?.opened) continue;
    const date = day(d);
    for (const h of habits) {
      if (d < h.startDay || !h.days.includes(weekdayOf(date))) continue;
      const value = past.values[h.id];
      const planned = past.planned[h.id];
      if (value === undefined && planned === undefined) continue;
      const o: ObservationRecord = {
        habitId: h.id, date, kind: h.kind, ...(planned ? { planned } : { value }),
        loggedAt: at(date, 1260), isBackfill: false, editedAfterClose: false,
      };
      observations.push(await storedRow(cipher, 'observations', observationToParts(o), stamp));
    }
    const record: DayRecord = { date, closedAt: at(date, past.lightsOut ?? 1380), restDay: false, reopenedCount: 0, ...(past.lightsOut !== undefined ? { lightsOut: past.lightsOut } : {}) };
    days.push(await storedRow(cipher, 'days', dayToParts(record), stamp));
  }
  const entries: object[] = [];
  for (const [i, e] of fx.entries.entries()) {
    const written = at(e.date, e.at);
    if (written <= now) entries.push(await storedRow(cipher, 'entries', entryToParts({ id: idWrittenAt(written, i), date: e.date, body: e.body }), stamp));
  }
  const notyet: object[] = [];
  for (const [i, n] of fx.notyet.entries()) {
    const written = at(n.date, n.at);
    if (written <= now) notyet.push(await storedRow(cipher, 'notyet', notYetToParts({ id: idWrittenAt(written, 100 + i), text: n.text }), stamp));
  }
  await db.observations.bulkPut(observations as never[]);
  await db.days.bulkPut(days as never[]);
  await db.entries.bulkPut(entries as never[]);
  await db.notyet.bulkPut(notyet as never[]);
  const seeded = await reopen(started);

  // today, as far as the clock has got, through the record's own operations at each event's minute
  const script = (state.variant === 'hard' ? fx.today.hard : fx.today[String(state.day)]) ?? fx.today['17'] ?? [];
  for (const e of script) {
    if (e.at > state.minute) continue;
    clock.set(at(today, e.at));
    const done = e.id === 'close' ? await closeDay(core, { date: today, lightsOut: Number(e.v) })
      : e.id === 'intent' || e.id === 'remark' ? await saveDayWords(core, { date: today, [e.id]: String(e.v) })
      : habits.some(h => h.id === e.id) ? await logObservation(core, { habitId: e.id, date: today, value: e.v as number | TriValue })
      : undefined;
    if (done && done.kind !== 'Saved') throw new Error(`fixture today ${e.id}: ${done.kind}`);
  }
  clock.set(now);
  return seeded;
}
