import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { openDb, type RecordDb } from '../../src/record/db.ts';
import { openRecord } from '../../src/record/core.ts';
import { firstRun } from '../../src/record/ops/firstRun.ts';
import { openSession } from '../../src/record/ops/session.ts';
import { createHabit } from '../../src/record/ops/habits.ts';
import { clearObservation, logObservation } from '../../src/record/ops/observations.ts';
import { saveEntry, saveNotYet } from '../../src/record/ops/words.ts';
import { deleteCue } from '../../src/record/ops/cues.ts';
import { saveReview } from '../../src/record/ops/reviews.ts';
import { stubCipher } from './stubCipher.ts';
import { stubBackup } from './stubBackup.ts';
import { guarded, guardedBackup } from './txGuard.ts';
import { SETTINGS, VAULT, WRAPPERS, testClock } from './fixtures.ts';

/** A fresh, empty database in its own in-memory store. */
export function freshDb(): RecordDb {
  return openDb({ name: 'daily-commit-test', indexedDB: new IDBFactory(), IDBKeyRange });
}

/** A record through first run and open, with a hand-moved clock that starts on a Monday morning (UTC). */
export async function openedRecord(iso = '2026-01-05T09:00:00Z') {
  const db = freshDb();
  const clock = testClock(iso);
  const core = openRecord({ db, now: clock.now });
  const result = await firstRun(core, { cipher: guarded(stubCipher()), vault: VAULT, wrappers: WRAPPERS, settings: SETTINGS });
  if (result.kind !== 'Saved') throw new Error(`first run: ${result.kind}`);
  return { db, clock, core };
}

/**
 * A record holding one of each kind of row, tombstones included, all invented, and opened with a
 * backup key as well. Its clock ends at 2026-01-06 20:00 (UTC).
 */
export async function filledRecord() {
  const t = await openedRecord();
  const { core, clock } = t;
  await core.lock();
  await openSession(core, guarded(stubCipher()), guardedBackup(stubBackup()));
  const must = async (what: string, pending: Promise<{ readonly kind: string }>) => {
    const result = await pending;
    if (result.kind !== 'Saved') throw new Error(`${what}: ${result.kind}`);
  };
  await must('habit', createHabit(core, {
    id: 'h-walk', name: 'CANARY-TEST walk', kind: 'tri', days: [0, 1, 2, 3, 4, 5, 6], asked: 'evening', target: {}, tier: 'focus',
    cues: [{ id: 'c-walk', text: 'Stand up and stretch', times: { every: 60, from: 420, to: 1320 }, private: false }],
  }));
  await must('log', logObservation(core, { habitId: 'h-walk', date: '2026-01-05', value: 'did' }));
  clock.set('2026-01-06T20:00:00Z');
  await must('log', logObservation(core, { habitId: 'h-walk', date: '2026-01-06', value: 'partly' }));
  await must('clear', clearObservation(core, { habitId: 'h-walk', date: '2026-01-06' }));      // leaves a tombstone
  await must('page', saveEntry(core, { id: 'e-page', body: 'CANARY-TEST page' }));
  await must('not yet', saveNotYet(core, { id: 'n-later', text: 'CANARY-TEST later' }));
  await must('reminder', deleteCue(core, { id: 'c-walk' }));                                   // leaves a tombstone
  await must('review', saveReview(core, { period: 'week', start: '2026-01-05', answers: { went: 'CANARY-TEST' } }));
  return t;
}
