// Times the change log (D-25) through the real vault and record/: one save with its lines, and the
// automatic backup carrying a heavy month of lines on top of two years of record. Not a test: run by
// hand, node tests/vault/benchLog.ts. It prints timings, counts and sizes only. Invented data.
import { openRecord } from '../../src/record/core.ts';
import { firstRun } from '../../src/record/ops/firstRun.ts';
import { createHabit } from '../../src/record/ops/habits.ts';
import { logObservation } from '../../src/record/ops/observations.ts';
import { saveEntry } from '../../src/record/ops/words.ts';
import { storedRow } from '../../src/record/ops/common.ts';
import { dayToParts, entryToParts, observationToParts } from '../../src/record/mapping.ts';
import type { ObservationRecord } from '../../src/record/model.ts';
import { bodyJson, gzip, readRaw } from '../../src/record/backup/body.ts';
import { jsonBytes } from '../../src/record/bytes.ts';
import { changeRows } from '../../src/record/changes.ts';
import { addDays, datesFrom } from '../../src/rules/dates.ts';
import type { TriValue } from '../../src/rules/types.ts';
import { createVault } from '../../src/vault/keys.ts';
import { systemRandom } from '../../src/vault/random.ts';
import { sessionCiphers } from '../../src/vault/vault.ts';
import { sealBackup } from '../../src/record/backup/export.ts';
import { sealSnapshot } from '../../src/record/backup/snapshot.ts';
import { sealMonth } from '../../src/record/backup/monthLog.ts';
import { freshDb } from '../record/helpers.ts';
import { memoryFiles } from '../record/memoryFiles.ts';
import { SETTINGS, testClock } from '../record/fixtures.ts';

const START = '2024-01-01';
const YEARS_DAYS = 730;
const HABITS = 12;
const SMALL_A_DAY = 60;          // the design's heavy case: 60 small changes a day
const PAGES_A_DAY = 6;           // and 6 diary saves a day of a ~4 KB page
const MONTH = 30;
const VALUES: readonly TriValue[] = ['did', 'partly', 'not', 'did'];

const db = freshDb();
const clock = testClock(`${START}T09:00:00Z`);
const core = openRecord({ db, now: clock.now });
const made = await createVault('CANARY bench passphrase', systemRandom, clock.now());
const { cipher, backup } = sessionCiphers(made.keys);
const setup = await firstRun(core, { cipher, backup, vault: made.vault, wrappers: made.wrappers, settings: { ...SETTINGS, journeyStart: START } });
if (setup.kind !== 'Saved') throw new Error(`first run: ${setup.kind}`);
for (let h = 0; h < HABITS; h++) {
  const r = await createHabit(core, { id: `bench-habit-${h}`, name: `CANARY habit ${h}`, kind: 'tri', days: [0, 1, 2, 3, 4, 5, 6], asked: 'evening', target: {}, tier: h < 3 ? 'focus' : 'log', startedOn: START });
  if (r.kind !== 'Saved') throw new Error(`habit ${h}: ${r.kind}`);
}

// two years of record, sealed with the real cipher and stored directly
const lastOld = addDays(START, YEARS_DAYS - 1);
const stamp = { updated_at: clock.now(), updated_by: 'bench' };
const observations: object[] = [];
for (const [d, date] of datesFrom(START, lastOld).entries()) {
  for (let h = 0; h < HABITS; h++) {
    const o: ObservationRecord = { habitId: `bench-habit-${h}`, date, kind: 'tri', value: VALUES[(d + h) % VALUES.length] ?? 'did', loggedAt: clock.now(), isBackfill: false, editedAfterClose: false };
    observations.push(await storedRow(cipher, 'observations', observationToParts(o), stamp));
  }
}
const oldDates = datesFrom(START, lastOld);
await db.observations.bulkPut(observations as never[]);
await db.days.bulkPut(await Promise.all(oldDates.map(date => storedRow(cipher, 'days', dayToParts({ date, restDay: false, reopenedCount: 0, closedAt: clock.now(), intent: 'CANARY intent' }), stamp))) as never[]);
await db.entries.bulkPut(await Promise.all(oldDates.map((date, i) => storedRow(cipher, 'entries', entryToParts({ id: `bench-old-${i}`, date, body: 'CANARY page line. '.repeat(220) }), stamp))) as never[]);

// one heavy month through the real write path, so every line comes from the logger
const before = await db.changes.count();
const saveMs: number[] = [];
const firstNew = addDays(lastOld, 1);
for (let d = 0; d < MONTH; d++) {
  const date = addDays(firstNew, d);
  clock.set(`${date}T09:00:00Z`);
  for (let i = 0; i < SMALL_A_DAY; i++) {
    const t = performance.now();
    const r = await logObservation(core, { habitId: `bench-habit-${i % HABITS}`, date, value: VALUES[(i + d) % VALUES.length] ?? 'did' });
    saveMs.push(performance.now() - t);
    if (r.kind !== 'Saved') throw new Error(`log: ${r.kind}`);
    clock.advance(1000);
  }
  let page = '';
  for (let i = 0; i < PAGES_A_DAY; i++) {
    page += `CANARY sentence ${i} of day ${d}. `.repeat(28);
    const r = await saveEntry(core, { id: `bench-page-${d}`, body: page.padEnd(4096 * (i + 1) / PAGES_A_DAY, '.') });
    if (r.kind !== 'Saved') throw new Error(`page: ${r.kind}`);
    clock.advance(1000);
  }
}
const lines = (await db.changes.count()) - before;

// the logger's own share of a save: lines for one changed observation, made alone
const logMs: number[] = [];
const sample = await db.observations.get(['bench-habit-0', addDays(firstNew, MONTH - 1)]);
for (let i = 0; i < 40; i++) {
  const o: ObservationRecord = { habitId: 'bench-habit-0', date: addDays(firstNew, MONTH - 1), kind: 'tri', value: i % 2 ? 'did' : 'not', loggedAt: clock.now(), isBackfill: false, editedAfterClose: false };
  const row = await storedRow(cipher, 'observations', observationToParts(o), { updated_at: clock.now(), updated_by: 'bench' });
  const t = performance.now();
  await changeRows({ db, cipher, puts: [{ table: 'observations', row }], stamp: { updated_at: clock.now(), updated_by: 'bench' }, newId: () => crypto.randomUUID() });
  logMs.push(performance.now() - t);
}
if (!sample) throw new Error('no sample row');
const logBytes = jsonBytes(await db.changes.toArray()).length;

// the automatic backup's work: every row to text, gzip, seal; once without the log, once with it
const median = (xs: readonly number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] ?? 0;
async function snapshot(withLog: boolean): Promise<{ readonly ms: number; readonly bytes: number }> {
  const t = performance.now();
  const raw = await readRaw(db);
  const body = withLog ? jsonBytes({ ...JSON.parse(new TextDecoder().decode(bodyJson(raw.tables))), changes: await db.changes.toArray() }) : bodyJson(raw.tables);
  const sealed = await backup.sealBody(await gzip(body), new Uint8Array(8), crypto.getRandomValues(new Uint8Array(12)));
  return { ms: performance.now() - t, bytes: sealed.length };
}
const plain = [await snapshot(false), await snapshot(false), await snapshot(false)];
const logged = [await snapshot(true), await snapshot(true), await snapshot(true)];
const mb = (n: number) => (n / 1_048_576).toFixed(1);

// the real lock at the start of the next month: the month file and the snapshot, sealed together
const session = core.session;
if (!session) throw new Error('locked');
clock.set(`${addDays(firstNew, MONTH + 3)}T09:00:00Z`);
const archiving: { readonly ms: number; readonly month: number; readonly latest: number }[] = [];
for (let i = 0; i < 3; i++) {
  const t = performance.now();
  const sealed = await sealSnapshot(db, { ...session, changed: true }, memoryFiles().files, clock.now(), { appVersion: 'bench' });
  archiving.push({ ms: performance.now() - t, month: sealed?.month?.bytes.length ?? 0, latest: sealed?.bytes.length ?? 0 });
}
const after = await sealBackup(db, session, clock.now(), { appVersion: 'bench' }, Infinity);
const parts: Record<string, number> = {};
const timed = async <T>(name: string, run: () => Promise<T>): Promise<T> => { const t = performance.now(); const out = await run(); parts[name] = performance.now() - t; return out; };
await timed('month sealed',() => sealMonth(db, { ...session, changed: true }, memoryFiles().files, clock.now(), { appVersion: 'bench' }));
await timed('latest sealed', () => sealBackup(db, session, clock.now(), { appVersion: 'bench' }, -Infinity));
console.log(`Node ${process.versions.node}; record ${YEARS_DAYS} days x ${HABITS} habits + a page a day; then ${MONTH} days x (${SMALL_A_DAY} small + ${PAGES_A_DAY} page saves)`);
console.log(`  one save with its lines   median ${median(saveMs).toFixed(1)} ms, slowest ${Math.max(...saveMs).toFixed(1)} ms (${saveMs.length} saves)`);
console.log(`  the logger's own share    median ${median(logMs).toFixed(1)} ms of that`);
console.log(`  lines in the month        ${lines}, stored ${mb(logBytes)} MB (about ${mb(logBytes * 12)} MB a year at this rate)`);
console.log(`  backup without the log    median ${Math.round(median(plain.map(x => x.ms)))} ms, ${mb(plain[0]?.bytes ?? 0)} MB`);
console.log(`  backup with the month     median ${Math.round(median(logged.map(x => x.ms)))} ms, ${mb(logged[0]?.bytes ?? 0)} MB`);
console.log(`  the archiving lock        median ${Math.round(median(archiving.map(x => x.ms)))} ms: month file ${mb(archiving[0]?.month ?? 0)} MB + latest ${mb(archiving[0]?.latest ?? 0)} MB`);
console.log(`  latest after it           ${mb(after.bytes.length)} MB (no archived lines)`);
console.log(`  parts                     ${Object.entries(parts).map(([k, v]) => `${k} ${Math.round(v)} ms`).join(', ')}`);
