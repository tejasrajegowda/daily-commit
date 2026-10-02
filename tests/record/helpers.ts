import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { openDb, type RecordDb } from '../../src/record/db.ts';
import { openRecord } from '../../src/record/core.ts';
import { firstRun } from '../../src/record/ops/firstRun.ts';
import { stubCipher } from './stubCipher.ts';
import { guarded } from './txGuard.ts';
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
