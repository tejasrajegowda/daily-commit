// An invented record, built on this PC through record/'s own operations and exported. Nothing is
// written but the bytes this returns. The passphrase and the recovery code stay in the caller's
// memory. Imported only by the emulator checks.
import { readFileSync } from 'node:fs';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { exportBackup } from '../../../src/record/backup/export.ts';
import { openRecord } from '../../../src/record/core.ts';
import { openDb } from '../../../src/record/db.ts';
import { saveDayWords } from '../../../src/record/ops/days.ts';
import { saveCue } from '../../../src/record/ops/cues.ts';
import { firstRun } from '../../../src/record/ops/firstRun.ts';
import { createHabit } from '../../../src/record/ops/habits.ts';
import { saveEntry, saveNotYet } from '../../../src/record/ops/words.ts';
import type { Result } from '../../../src/record/results.ts';
import { localDateOf } from '../../../src/rules/dates.ts';
import type { Weekday } from '../../../src/rules/types.ts';
import { createVault } from '../../../src/vault/keys.ts';
import { systemRandom } from '../../../src/vault/random.ts';
import { sessionCiphers } from '../../../src/vault/vault.ts';

export interface SeedCanaries {
  readonly diary: string;
  readonly notYet: string;
  readonly intent: string;
  readonly remark: string;
  readonly privateCue: string;
  readonly shownCue: string;
}

export interface Seed {
  readonly file: Uint8Array;
  readonly passphrase: string;
  readonly recoveryCode: string;
  readonly canaries: SeedCanaries;
  readonly habit: string;
}

/** Fixed, and none of them repeats inside itself, so a compressed store keeps each as a literal. */
export const SEED_CANARIES: SeedCanaries = {
  diary: 'CANARY-L2-DIARY-7QX4M',
  notYet: 'CANARY-L2-NOTYET-K2PV9',
  intent: 'CANARY-L2-INTENT-W8RZ3',
  remark: 'CANARY-L2-REMARK-H5TN6',
  privateCue: 'CANARY-L2-PRIVATE-B3JQ8',
  shownCue: 'CANARY-L2-SHOWN-F6YD2',
};

const PASSPHRASE = 'CANARY-L2 test passphrase';
const DAYS: readonly Weekday[] = [0, 1, 2, 3, 4, 5, 6];

function appVersion(): string {
  const parsed = JSON.parse(readFileSync(new URL('../../../package.json', import.meta.url), 'utf8')) as { version?: unknown };
  if (typeof parsed.version !== 'string') throw new Error('package.json has no version');
  return parsed.version;
}

function must(what: string, result: Result<unknown>): void {
  if (result.kind === 'Saved') return;
  const reason = result.kind === 'Invalid' ? ` (${result.reason})` : '';
  throw new Error(`${what}: ${result.kind}${reason}`);
}

/**
 * An invented record in fake-indexeddb, exported. Its timezone is UTC. Its two reminders are at
 * the given minutes today. Waking at 00:00 and lights-out at 23:59 are accepted; only 23:59 is quiet.
 */
export async function seed(nowMs: number, cueMinutes: { readonly shown: number; readonly private: number }): Promise<Seed> {
  const tz = 'UTC';
  const boundary = 240;
  const journeyStart = localDateOf(nowMs, tz, boundary);
  const db = openDb({ name: `daily-commit-seed-${nowMs}-${systemRandom(4).join('-')}`, indexedDB: new IDBFactory(), IDBKeyRange });
  try {
    const core = openRecord({ db, now: () => nowMs });
    const made = await createVault(PASSPHRASE, systemRandom, nowMs);
    const { cipher, backup } = sessionCiphers(made.keys);
    must('first run', await firstRun(core, {
      cipher, backup, vault: made.vault, wrappers: made.wrappers,
      settings: { tz, boundary, journeyStart, wakePlan: 0, lightsOutPlan: 1439, cuesOn: true },
    }));
    must('habit', await createHabit(core, {
      id: 'h-walk', name: 'Walk', kind: 'tri', days: DAYS, asked: 'evening', target: {}, tier: 'focus',
    }));
    must('shown cue', await saveCue(core, {
      id: 'c-shown', habitId: 'h-walk', kind: 'cue', text: SEED_CANARIES.shownCue,
      times: { at: [cueMinutes.shown] }, enabled: true, private: false,
    }));
    must('private cue', await saveCue(core, {
      id: 'c-private', habitId: null, kind: 'checkin', text: SEED_CANARIES.privateCue,
      times: { at: [cueMinutes.private] }, enabled: true, private: true,
    }));
    must('diary', await saveEntry(core, { id: 'e-diary', body: SEED_CANARIES.diary }));
    must('not yet', await saveNotYet(core, { id: 'n-later', text: SEED_CANARIES.notYet }));
    must('day words', await saveDayWords(core, { date: journeyStart, intent: SEED_CANARIES.intent, remark: SEED_CANARIES.remark }));
    const exported = await exportBackup(core, { appVersion: appVersion() });
    if (exported.kind !== 'Saved') must('export', exported);
    return {
      file: exported.kind === 'Saved' ? exported.value.bytes : new Uint8Array(),
      passphrase: PASSPHRASE,
      recoveryCode: made.recoveryCode,
      canaries: SEED_CANARIES,
      habit: 'Walk',
    };
  } finally {
    db.close();
  }
}
