// The harness's record: nine invented habits and their history, made the same way every time.
// First run and the habits go through the record's own operations; the history is sealed by the
// real cipher and stored directly, as the timing script does, because a past day can't be logged
// once it is closed.
import { openRecord, type RecordCore } from '../../../src/record/core.ts';
import type { RecordDb } from '../../../src/record/db.ts';
import { dayToParts, entryToParts, observationToParts } from '../../../src/record/mapping.ts';
import type { DayRecord, ObservationRecord, Settings } from '../../../src/record/model.ts';
import { storedRow } from '../../../src/record/ops/common.ts';
import { firstRun } from '../../../src/record/ops/firstRun.ts';
import { createHabit, type NewHabit } from '../../../src/record/ops/habits.ts';
import { openSession } from '../../../src/record/ops/session.ts';
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
  for (const { startDay, ...h } of HABITS) {
    if (startDay > state.day) continue;
    const made = await createHabit(core, { ...h, startedOn: dateOfDay(startDay, state.start) });
    if (made.kind !== 'Saved') throw new Error(`habit ${h.id}: ${made.kind}`);
  }

  const next = generator(7);
  const observations: object[] = [];
  const days: object[] = [];
  const entries: object[] = [];
  // the "steady" variant keeps Walk done every day, for the offer to stop asking (eight steady weeks)
  const steady = state.variant === 'steady';
  // canary=1 marks yesterday: a wake-up at 06:55, an hour and 25 minutes of practice, and a marked intent
  const marked = (d: number) => state.canary && d === state.day - 1;
  for (let d = 1; d < state.day; d++) {
    const opened = next() >= 1 / 9 || steady || marked(d);
    const date = dateOfDay(d, state.start);
    const weekday = ((d - 1) % 7) as Weekday;
    const evening = Date.parse(`${date}T21:00:00Z`);
    for (const h of HABITS) {
      const drawn = valueFor(h, next);                   // drawn for every habit, so a skipped day keeps the rest the same
      const value = steady && h.id === 'h-walk' ? 'did' : marked(d) && h.id === 'h-wake' ? 415 : marked(d) && h.id === 'h-practice' ? 85 : drawn;
      if (!opened || value === undefined || d < h.startDay || !h.days.includes(weekday)) continue;
      const o: ObservationRecord = { habitId: h.id, date, kind: h.kind, value, loggedAt: evening, isBackfill: false, editedAfterClose: false };
      observations.push(await storedRow(cipher, 'observations', observationToParts(o), stamp));
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
