// Times unlock and Look back on an invented three-year record, through the real vault, record/ and
// rules/. Not a test: run by hand, node tests/vault/bench.ts. It prints timings and counts only.
import { openRecord } from '../../src/record/core.ts';
import { firstRun } from '../../src/record/ops/firstRun.ts';
import { createHabit } from '../../src/record/ops/habits.ts';
import { openSession } from '../../src/record/ops/session.ts';
import { vaultRows } from '../../src/record/ops/vault.ts';
import { storedRow } from '../../src/record/ops/common.ts';
import { dayToParts, entryToParts, observationToParts } from '../../src/record/mapping.ts';
import { rulesInput } from '../../src/record/read.ts';
import type { ObservationRecord } from '../../src/record/model.ts';
import { addDays, datesFrom } from '../../src/rules/dates.ts';
import { focusDone, heatLevel } from '../../src/rules/heat.ts';
import { habitNumbers } from '../../src/rules/stats.ts';
import type { TriValue } from '../../src/rules/types.ts';
import { createVault } from '../../src/vault/keys.ts';
import { systemRandom } from '../../src/vault/random.ts';
import { sessionCiphers, unlockWithSecret } from '../../src/vault/vault.ts';
import { freshDb } from '../record/helpers.ts';
import { SETTINGS, testClock } from '../record/fixtures.ts';

const PASSPHRASE = 'CANARY bench passphrase';
const START = '2023-01-02';
const DAYS = 1095;
const HABITS = 12;
const RUNS = 3;
const VALUES: readonly TriValue[] = ['did', 'did', 'partly', 'not'];

const db = freshDb();
const clock = testClock(`${START}T09:00:00Z`);
const core = openRecord({ db, now: clock.now });
const made = await createVault(PASSPHRASE, systemRandom, clock.now());
const { cipher, backup } = sessionCiphers(made.keys);
const setup = await firstRun(core, { cipher, backup, vault: made.vault, wrappers: made.wrappers, settings: { ...SETTINGS, journeyStart: START } });
if (setup.kind !== 'Saved') throw new Error(`first run: ${setup.kind}`);
for (let h = 0; h < HABITS; h++) {
  const result = await createHabit(core, {
    id: `bench-habit-${h}`, name: `CANARY habit ${h}`, kind: 'tri', days: [0, 1, 2, 3, 4, 5, 6], asked: 'evening', target: {}, tier: h < 3 ? 'focus' : 'log',
  });
  if (result.kind !== 'Saved') throw new Error(`habit ${h}: ${result.kind}`);
}

// three years of rows, sealed with the real cipher and stored directly (the operations would take minutes)
const today = addDays(START, DAYS - 1);
const dates = datesFrom(START, today);
const stamp = { updated_at: clock.now(), updated_by: 'bench' };
const observations: object[] = [];
for (const [d, date] of dates.entries()) {
  for (let h = 0; h < HABITS; h++) {
    const o: ObservationRecord = {
      habitId: `bench-habit-${h}`, date, kind: 'tri', value: VALUES[(d * 7 + h * 3) % VALUES.length] ?? 'did', loggedAt: clock.now(), isBackfill: false, editedAfterClose: false,
    };
    observations.push(await storedRow(cipher, 'observations', observationToParts(o), stamp));
  }
}
const days = await Promise.all(dates.map(date => storedRow(cipher, 'days', dayToParts({ date, restDay: false, reopenedCount: 0, closedAt: clock.now(), intent: 'CANARY intent' }), stamp)));
const entries = await Promise.all(dates.filter((_, d) => d % 4 === 0).map((date, i) => storedRow(cipher, 'entries', entryToParts({ id: `bench-entry-${i}`, date, body: 'CANARY page '.repeat(40) }), stamp)));
await db.observations.bulkPut(observations as never[]);
await db.days.bulkPut(days as never[]);
await db.entries.bulkPut(entries as never[]);
const rowCount = HABITS + observations.length + days.length + entries.length;

const ms = (from: number) => Math.round(performance.now() - from);
const median = (xs: readonly number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] ?? 0;
const timings = { stretch: [] as number[], open: [] as number[], lookBack: [] as number[] };
for (let run = 0; run < RUNS; run++) {
  await core.lock();
  const rows = await vaultRows(core);
  if (!rows) throw new Error('no vault');
  let t = performance.now();
  const opened = await unlockWithSecret(rows, { method: 'passphrase', text: PASSPHRASE });
  if (opened.kind !== 'Unlocked') throw new Error(opened.kind);
  timings.stretch.push(ms(t));
  t = performance.now();
  const ciphers = sessionCiphers(opened.keys);
  await openSession(core, ciphers.cipher, ciphers.backup);
  timings.open.push(ms(t));
  t = performance.now();
  const model = core.session?.model;
  if (!model) throw new Error('not open');
  const input = rulesInput(model);
  const heat = dates.map(date => heatLevel(focusDone(input.habits, input.index, date)));
  const numbers = input.habits.map(h => habitNumbers(h, input.index, START, today));
  timings.lookBack.push(ms(t));
  if (heat.length !== DAYS || numbers.length !== HABITS) throw new Error('Look back came out short');
}
console.log(`rows ${rowCount} (observations ${observations.length}, days ${days.length}, pages ${entries.length}); median of ${RUNS} runs, Node ${process.versions.node}:`);
console.log(`  passphrase stretch + keys  ${median(timings.stretch)} ms`);
console.log(`  opening every row          ${median(timings.open)} ms`);
console.log(`  unlock in all              ${median(timings.stretch) + median(timings.open)} ms`);
console.log(`  Look back (3 years)        ${median(timings.lookBack)} ms`);
