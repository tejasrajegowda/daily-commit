// The harness's record: ten invented habits and their history, made the same way every time.
// First run and the habits go through the record's own operations; the history is sealed by the
// real cipher and stored directly, as the timing script does, because a past day can't be logged
// once it is closed.
import { openRecord, type RecordCore } from '../../../src/record/core.ts';
import type { RecordDb } from '../../../src/record/db.ts';
import { dayToParts, entryToParts, habitToParts, observationToParts } from '../../../src/record/mapping.ts';
import type { DayRecord, HabitRecord, ObservationRecord, Settings } from '../../../src/record/model.ts';
import { storedRow } from '../../../src/record/ops/common.ts';
import { firstRun } from '../../../src/record/ops/firstRun.ts';
import { createHabit, type NewHabit } from '../../../src/record/ops/habits.ts';
import { openSession } from '../../../src/record/ops/session.ts';
import { DEFAULT_BOUNDARY, toDayMinute } from '../../../src/rules/clock.ts';
import type { TriValue, Weekday } from '../../../src/rules/types.ts';
import { createVault } from '../../../src/vault/keys.ts';
import { systemRandom } from '../../../src/vault/random.ts';
import { sessionCiphers } from '../../../src/vault/vault.ts';
import { dateOfDay, nowOf, START, type HarnessState } from './state.ts';

export const HARNESS_PASSPHRASE = 'CANARY harness passphrase';
/** the own code the harness sets up when a state asks for one */
export const HARNESS_CODE = '24681357';

export const HARNESS_SETTINGS: Settings = { tz: 'UTC', boundary: 240, journeyStart: START, wakePlan: 420, lightsOutPlan: 1380, cuesOn: true };

const EVERY_DAY: readonly Weekday[] = [0, 1, 2, 3, 4, 5, 6];
const WEEKDAYS: readonly Weekday[] = [0, 1, 2, 3, 4];

type FixtureHabit = Omit<NewHabit, 'startedOn' | 'sheet'> & { readonly startDay: number };

const HABITS: readonly FixtureHabit[] = [
  { id: 'h-wake', name: 'Wake up', sub: 'aim 07:00', kind: 'time', tier: 'focus', asked: 'morning', days: EVERY_DAY, target: { band: 420, part: 450 }, startDay: 1 },
  { id: 'h-walk', name: 'Walk', sub: 'twenty minutes outside', kind: 'tri', tier: 'focus', asked: 'evening', days: EVERY_DAY, target: {}, startDay: 1 },
  { id: 'h-practice', name: 'Practice', sub: 'aim 1h', kind: 'min', tier: 'focus', asked: 'morning', days: WEEKDAYS, target: { bar: 15, aim: 60 }, startDay: 1 },
  { id: 'h-plan', name: 'Plan the day', sub: 'three things, on paper', kind: 'tri', tier: 'log', asked: 'morning', days: EVERY_DAY, target: {}, startDay: 1 },
  { id: 'h-read', name: 'Read', sub: 'ten pages', kind: 'tri', tier: 'log', asked: 'evening', days: EVERY_DAY, target: {}, startDay: 1 },
  { id: 'h-tidy', name: 'Tidy up', sub: 'ten minutes', kind: 'tri', tier: 'log', asked: 'evening', days: EVERY_DAY, target: {}, startDay: 1 },
  { id: 'h-water', name: 'Water', sub: 'a glass with each meal', kind: 'tri', tier: 'log', asked: 'evening', days: EVERY_DAY, target: {}, startDay: 1 },
  { id: 'h-stretch', name: 'Stretch', sub: 'five minutes', kind: 'tri', tier: 'log', asked: 'morning', days: EVERY_DAY, target: {}, startDay: 30 },
  { id: 'h-mood', name: 'Mood', kind: 'mood', tier: 'log', asked: 'evening', days: EVERY_DAY, target: {}, startDay: 1 },
  // a time habit asked at night (R3-12): its recorded times straddle midnight
  { id: 'h-bed', name: 'In bed', sub: 'aim by 00:30', kind: 'time', tier: 'log', asked: 'evening', days: EVERY_DAY, target: { band: toDayMinute(30, 'evening', DEFAULT_BOUNDARY) }, startDay: 1 },
];

export const FIXTURE_HABITS: readonly NewHabit[] = HABITS.map(({ startDay: _, ...h }) => h);

const INTENTS = ['A quiet day', 'Errands, then reading', 'Out most of the day', 'Catch up on things'];
const TRI: readonly (TriValue | undefined)[] = ['did', 'did', 'did', 'partly', 'not', undefined];

/** A small seeded generator (mulberry32), so every run draws the same record. */
function generator(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function valueFor(h: FixtureHabit, next: () => number): number | TriValue | undefined {
  const x = next();
  if (h.kind === 'time') return x < 0.1 ? undefined : 400 + Math.round(x * 16) * 5;          // 06:40 to 08:00
  if (h.kind === 'min') return x < 0.15 ? undefined : Math.round(x * 18) * 5;                  // 0 to 90 minutes
  if (h.kind === 'mood') return x < 0.2 ? undefined : 1 + Math.floor(x * 4.99);
  return TRI[Math.floor(x * TRI.length)];
}

export interface Seeded {
  readonly core: RecordCore;
  readonly clock: { now(): number; set(ms: number): void };
  readonly recoveryCode: string;
}

/** A record after first run, open, with its ciphers, for a seed to fill. */
export interface Started extends Seeded {
  readonly cipher: ReturnType<typeof sessionCiphers>['cipher'];
  readonly backup: ReturnType<typeof sessionCiphers>['backup'];
  /** the change stamp of every row a seed stores directly */
  readonly stamp: { readonly updated_at: number; readonly updated_by: string };
}

/** First run on `db` at the state's clock, with `settings`. */
export async function startRecord(db: RecordDb, state: HarnessState, settings: Settings): Promise<Started> {
  let now = nowOf(state);
  const clock = { now: () => now, set: (ms: number) => { now = ms; } };
  const core = openRecord({ db, now: clock.now });
  const made = await createVault(HARNESS_PASSPHRASE, systemRandom, now);
  const { cipher, backup } = sessionCiphers(made.keys);
  const setup = await firstRun(core, { cipher, backup, vault: made.vault, wrappers: made.wrappers, settings });
  if (setup.kind !== 'Saved') throw new Error(`first run: ${setup.kind}`);
  return { core, clock, recoveryCode: made.recoveryCode, cipher, backup, stamp: { updated_at: now, updated_by: 'harness' } };
}

/** Rows stored around the session are read by opening it again. */
export async function reopen(started: Started): Promise<Seeded> {
  await started.core.lock();
  await openSession(started.core, started.cipher, started.backup);
  return { core: started.core, clock: started.clock, recoveryCode: started.recoveryCode };
}

/** First run on `db`, the habits, then the finished days before `state.day`; the record is left open. */
export async function seedRecord(db: RecordDb, state: HarnessState): Promise<Seeded> {
  const started = await startRecord(db, state, HARNESS_SETTINGS);
  const { core, cipher, stamp } = started;
  // v=notime: no habit of kind 'time' at all, for the scenario where a time-only view has nothing to show
  const activeHabits = state.variant === 'notime' ? HABITS.filter(h => h.kind !== 'time') : HABITS;
  // v=pairs: Wake up's own band is widened so every value it is given here still reads as "did" —
  // it never gets a "not" day of its own, so it is never a source of a pairing itself, only a target
  // (R3-9's exact scenario rides on Walk's own done days, below, nothing else).
  for (const { startDay, ...h } of activeHabits) {
    if (startDay > state.day) continue;
    const target = state.variant === 'pairs' && h.id === 'h-wake' ? { band: 1000 } : h.target;
    const made = await createHabit(core, { ...h, target, startedOn: dateOfDay(startDay, state.start) });
    if (made.kind !== 'Saved') throw new Error(`habit ${h.id}: ${made.kind}`);
  }

  // v=retired (Plan): Walk (Focus) retired a week ago and Read moved into its slot, so Focus is
  // full by the time the screen draws — the scenario "Bring back" with no room runs into. "Today
  // never goes backwards" (record/time.ts) rules out backdating this through the real ops once
  // first run has stamped the target day, so the already-retired, already-swapped rows are written
  // directly, the same way the history below is.
  if (state.variant === 'retired' && state.day > 8) {
    const walk = core.session?.model.habits.get('h-walk');
    const read = core.session?.model.habits.get('h-read');
    if (!walk || !read) throw new Error('harness retired variant: h-walk or h-read missing');
    const movedOn = dateOfDay(state.day - 6, state.start);
    const retiredWalk: HabitRecord = { ...walk, periods: [{ from: walk.periods[0]?.from ?? movedOn, until: movedOn }] };
    const focusRead: HabitRecord = { ...read, tierHistory: [...read.tierHistory, { tier: 'focus', from: movedOn }] };
    await db.habits.bulkPut([
      await storedRow(cipher, 'habits', habitToParts(retiredWalk), stamp),
      await storedRow(cipher, 'habits', habitToParts(focusRead), stamp),
    ] as never[]);
  }

  const next = generator(7);
  const observations: object[] = [];
  const days: object[] = [];
  const entries: object[] = [];
  // the "steady" variant keeps Walk done every day, for the offer to stop asking (eight steady weeks)
  const steady = state.variant === 'steady';
  // v=rest: days 1-7 (the week before last) keep Walk done every day; days 8-14 (last week, with
  // `age` 17) plan Walk as rest on two days, so the week's rate stays the same (R3-7's scenario).
  const rest = state.variant === 'rest';
  const restDay = (d: number) => rest && d >= 8 && d <= 14 && (d === 8 || d === 11);
  // v=pairs: Walk's own done days (and nothing about any other habit) carry R3-9's rounding case;
  // the window it reads is day 28-55 (February, with `age` 60), kept apart from the random history.
  const pairs = state.variant === 'pairs';
  const withWake = [419, 419, 419, 419, 420, 420, 420, 420, 420, 420];        // mean 419.6
  const withDay = (d: number) => pairs && d >= 28 && d <= 37;                  // 10 days, Walk done
  const withoutDay = (d: number) => pairs && d >= 38 && d <= 55;               // 18 days, Walk not
  // canary=1 marks yesterday: a wake-up at 06:55, an hour and 25 minutes of practice, and a marked intent
  const marked = (d: number) => state.canary && d === state.day - 1;
  // In bed (h-bed, R3-12): clock times either side of midnight, kept as the DayMinutes a night
  // habit stores — 00:20 and 23:10 sit 70 minutes apart on that axis, not 1370 apart on a clock one
  const bedValue = (d: number) => toDayMinute(d % 3 === 0 ? 20 : 23 * 60 + 10, 'evening', DEFAULT_BOUNDARY);
  for (let d = 1; d < state.day; d++) {
    const opened = next() >= 1 / 9 || steady || rest || withDay(d) || withoutDay(d) || marked(d);
    const date = dateOfDay(d, state.start);
    const weekday = ((d - 1) % 7) as Weekday;
    const evening = Date.parse(`${date}T21:00:00Z`);
    for (const h of activeHabits) {
      if ((rest || withDay(d) || withoutDay(d)) && (h.id === 'h-walk' || h.id === 'h-wake')) continue; // seeded separately below
      if (h.id === 'h-bed') continue;                    // seeded separately below, with no draw from `next` (keeps every other habit's sequence as it was)
      const drawn = valueFor(h, next);                   // drawn for every habit, so a skipped day keeps the rest the same
      const value = steady && h.id === 'h-walk' ? 'did' : marked(d) && h.id === 'h-wake' ? 415 : marked(d) && h.id === 'h-practice' ? 85 : drawn;
      if (!opened || value === undefined || d < h.startDay || !h.days.includes(weekday)) continue;
      const o: ObservationRecord = { habitId: h.id, date, kind: h.kind, value, loggedAt: evening, isBackfill: false, editedAfterClose: false };
      observations.push(await storedRow(cipher, 'observations', observationToParts(o), stamp));
    }
    if (opened && activeHabits.some(h => h.id === 'h-bed')) {
      observations.push(await storedRow(cipher, 'observations', observationToParts(
        { habitId: 'h-bed', date, kind: 'time', value: bedValue(d), loggedAt: evening, isBackfill: false, editedAfterClose: false }), stamp));
    }
    if (rest && d <= 14) {
      const wake = valueFor(HABITS[0]!, next);            // kept random; only Walk's own days matter here
      if (restDay(d)) observations.push(await storedRow(cipher, 'observations', observationToParts(
        { habitId: 'h-walk', date, kind: 'tri', planned: 'rest', loggedAt: evening, isBackfill: false, editedAfterClose: false }), stamp));
      else observations.push(await storedRow(cipher, 'observations', observationToParts(
        { habitId: 'h-walk', date, kind: 'tri', value: 'did', loggedAt: evening, isBackfill: false, editedAfterClose: false }), stamp));
      if (typeof wake === 'number') observations.push(await storedRow(cipher, 'observations', observationToParts(
        { habitId: 'h-wake', date, kind: 'time', value: wake, loggedAt: evening, isBackfill: false, editedAfterClose: false }), stamp));
    }
    if (withDay(d) || withoutDay(d)) {
      const wake = withDay(d) ? withWake[d - 28]! : 430;
      observations.push(await storedRow(cipher, 'observations', observationToParts(
        { habitId: 'h-walk', date, kind: 'tri', value: withDay(d) ? 'did' : 'not', loggedAt: evening, isBackfill: false, editedAfterClose: false }), stamp));
      observations.push(await storedRow(cipher, 'observations', observationToParts(
        { habitId: 'h-wake', date, kind: 'time', value: wake, loggedAt: evening, isBackfill: false, editedAfterClose: false }), stamp));
    }
    const lightsOut = 1360 + Math.round(next() * 14) * 5;
    const drawnIntent = INTENTS[Math.floor(next() * INTENTS.length)];
    const intent = marked(d) ? 'CANARY-TEST yesterday' : drawnIntent;
    if (!opened) continue;
    const day: DayRecord = { date, closedAt: Date.parse(`${date}T22:30:00Z`), lightsOut, restDay: false, reopenedCount: 0, intent };
    days.push(await storedRow(cipher, 'days', dayToParts(day), stamp));
    if (d % 4 === 0) entries.push(await storedRow(cipher, 'entries', entryToParts({ id: `harness-page-${d}`, date, body: `CANARY page for day ${d}` }), stamp));
  }
  await db.observations.bulkPut(observations as never[]);
  await db.days.bulkPut(days as never[]);
  await db.entries.bulkPut(entries as never[]);
  return reopen(started);
}
