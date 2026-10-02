import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { openDb, type RecordDb } from '../../src/record/db.ts';

/** A fresh, empty database in its own in-memory store. */
export function freshDb(): RecordDb {
  return openDb({ name: 'daily-commit-test', indexedDB: new IDBFactory(), IDBKeyRange });
}
