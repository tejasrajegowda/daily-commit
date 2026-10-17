// An invented record for a timing run, built through record/'s own operations and the sealed rows
// bench.ts stores directly, then exported. The function writes nothing. The CLI writes one ignored
// file, and only when it fits the restore picker. No time zone is written in this file: the CLI
// reads the machine's when it runs.
import { mkdirSync, writeFileSync } from 'node:fs';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { APP_VERSION } from '../../../src/app/compose.ts';
import { exportBackup } from '../../../src/record/backup/export.ts';
import { openRecord } from '../../../src/record/core.ts';
import { openDb } from '../../../src/record/db.ts';
import { dayToParts, entryToParts, observationToParts } from '../../../src/record/mapping.ts';
import type { ObservationRecord } from '../../../src/record/model.ts';
import { storedRow } from '../../../src/record/ops/common.ts';
import { firstRun } from '../../../src/record/ops/firstRun.ts';
import { createHabit } from '../../../src/record/ops/habits.ts';
import type { Result } from '../../../src/record/results.ts';
import { addDays, datesFrom, localDateOf } from '../../../src/rules/dates.ts';
import type { TriValue, Weekday } from '../../../src/rules/types.ts';
import { createVault } from '../../../src/vault/keys.ts';
import { systemRandom } from '../../../src/vault/random.ts';
import { sessionCiphers } from '../../../src/vault/vault.ts';

export const LONG_PASSPHRASE = 'CANARY phone test passphrase';
export const LONG_FILE = '.local/android/dc-3year.dcbak';
export const PICK_CAP = 32 * 1024 * 1024;          // Task 4b's pickFile cap

const HABITS = 12;
const BOUNDARY = 240;
const WEEK: readonly Weekday[] = [0, 1, 2, 3, 4, 5, 6];
const VALUES: readonly TriValue[] = ['did', 'did', 'partly', 'not'];

function must(what: string, result: Result<unknown>): void {
  if (result.kind === 'Saved') return;
  const reason = result.kind === 'Invalid' ? ` (${result.reason})` : '';
  throw new Error(`${what}: ${result.kind}${reason}`);
}

/** An invented record of `days` days ending today in `tz`, shaped as tests/vault/bench.ts's: 12 'tri' habits (the
 *  first 3 focus) named `CANARY habit <n>`, a value every day, a day row with an intent every day, a diary page
 *  every fourth day; waking 00:00 and lights-out 23:59 (or the widest pair the settings validation allows, as
 *  seed.ts); reminders on, none set. Built in fake-indexeddb through record/'s own operations and bench.ts's
 *  sealed rows, then exported with exportBackup (appVersion APP_VERSION). Writes nothing itself. */
export async function longRecord(nowMs: number, tz: string, days: number): Promise<{ readonly file: Uint8Array; readonly habits: number; readonly days: number }> {
  const today = localDateOf(nowMs, tz, BOUNDARY);
  const journeyStart = addDays(today, 1 - days);
  const dates = datesFrom(journeyStart, today);
  if (dates.length !== days) throw new Error('the span is not the number of days asked for');
  const db = openDb({ name: `daily-commit-long-${nowMs}-${systemRandom(4).join('-')}`, indexedDB: new IDBFactory(), IDBKeyRange });
  try {
    const core = openRecord({ db, now: () => nowMs });
    const made = await createVault(LONG_PASSPHRASE, systemRandom, nowMs);
    const { cipher, backup } = sessionCiphers(made.keys);
    must('first run', await firstRun(core, {
      cipher, backup, vault: made.vault, wrappers: made.wrappers,
      settings: { tz, boundary: BOUNDARY, journeyStart, wakePlan: 0, lightsOutPlan: 1439, cuesOn: true },
    }));
    for (let h = 0; h < HABITS; h++) {
      // The clock is the last day. With no start day the habit would begin only then.
      must(`habit ${h}`, await createHabit(core, {
        id: `long-habit-${h}`, name: `CANARY habit ${h}`, kind: 'tri', days: WEEK, asked: 'evening', target: {},
        tier: h < 3 ? 'focus' : 'log', startedOn: journeyStart,
      }));
    }
    const session = core.session;
    if (!session) throw new Error('the record is not open');
    const stamp = { updated_at: session.lastWriteMs ?? nowMs, updated_by: session.deviceId };
    const observations: object[] = [];
    for (const [d, date] of dates.entries()) {
      for (let h = 0; h < HABITS; h++) {
        const value = VALUES[(d * 7 + h * 3) % VALUES.length] ?? 'did';
        const row: ObservationRecord = {
          habitId: `long-habit-${h}`, date, kind: 'tri', value, loggedAt: nowMs, isBackfill: false, editedAfterClose: false,
        };
        observations.push(await storedRow(cipher, 'observations', observationToParts(row), stamp));
      }
    }
    const dayRows = await Promise.all(dates.map(date => storedRow(cipher, 'days', dayToParts({
      date, restDay: false, reopenedCount: 0, closedAt: nowMs, intent: 'CANARY intent',
    }), stamp)));
    const entries = await Promise.all(dates.filter((_, d) => d % 4 === 0).map((date, i) => storedRow(
      cipher, 'entries', entryToParts({ id: `long-entry-${i}`, date, body: 'CANARY page '.repeat(40) }), stamp,
    )));
    if (observations.length !== days * HABITS || dayRows.length !== days || entries.length !== Math.floor((days - 1) / 4) + 1) {
      throw new Error('the long record is short');
    }
    await db.observations.bulkPut(observations as never[]);
    await db.days.bulkPut(dayRows as never[]);
    await db.entries.bulkPut(entries as never[]);
    const exported = await exportBackup(core, { appVersion: APP_VERSION });
    if (exported.kind !== 'Saved') must('export', exported);
    return { file: exported.kind === 'Saved' ? exported.value.bytes : new Uint8Array(), habits: HABITS, days };
  } finally {
    db.close();
  }
}

async function writeLongFile(): Promise<number> {
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const made = await longRecord(Date.now(), tz, 1095);
  if (made.file.byteLength > PICK_CAP) {
    console.error(`long record refused · ${made.file.byteLength} bytes · over the pick cap`);
    return 1;
  }
  mkdirSync('.local/android', { recursive: true });
  writeFileSync(LONG_FILE, made.file);
  const kb = Math.round(made.file.byteLength / 1024);
  console.log(`long record · ${made.days} days · ${made.habits} habits · ${kb} KB`);
  return 0;
}

if (import.meta.main) process.exitCode = await writeLongFile();
