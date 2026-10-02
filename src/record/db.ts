import Dexie, { type Table } from 'dexie';
import type {
  CueRow, DayRow, DeviceRow, EntryRow, HabitRow, MigrationRow, NotYetRow, ObservationRow, ReviewRow, SettingRow, VaultRow, WrapperRow,
} from './rows.ts';

// The one door to storage. In each line the first entry is the primary key and the rest are
// indexes. Only values that are always a valid key are indexed: never a null, a boolean or anything
// locked.

export const SCHEMA_V1 = {
  wrappers: 'method',
  vault: 'key',
  settings: 'key, updated_at',
  device: 'key',
  habits: 'id, updated_at',
  observations: '[habit_id+local_date], habit_id, local_date, updated_at',
  days: 'local_date, updated_at',
  entries: 'id, local_date, updated_at',
  notyet: 'id, updated_at',
  cues: 'id, updated_at',
  reviews: 'key, period_start, updated_at',
  migrations: 'id',
} as const;

export const SCHEMA_VERSION = 1;

export type TableName = keyof typeof SCHEMA_V1;

/** The tables that are synced, stamped and exported. */
export const SYNCED = ['settings', 'habits', 'observations', 'days', 'entries', 'notyet', 'cues', 'reviews'] as const;
export type SyncedTable = (typeof SYNCED)[number];

export type RecordDb = Dexie & {
  wrappers: Table<WrapperRow, string>;
  vault: Table<VaultRow, string>;
  settings: Table<SettingRow, string>;
  device: Table<DeviceRow, string>;
  habits: Table<HabitRow, string>;
  observations: Table<ObservationRow, [string, string]>;
  days: Table<DayRow, string>;
  entries: Table<EntryRow, string>;
  notyet: Table<NotYetRow, string>;
  cues: Table<CueRow, string>;
  reviews: Table<ReviewRow, string>;
  migrations: Table<MigrationRow, string>;
};

export interface StorageDeps {
  readonly name: string;
  readonly indexedDB: IDBFactory;
  readonly IDBKeyRange: typeof IDBKeyRange;
}

/**
 * Opens the record's database. Every write waits until it is on disk ("strict"), because Chrome's
 * relaxed default reports a save before the data is safe.
 */
export function openDb(deps: StorageDeps): RecordDb {
  const db = new Dexie(deps.name, { indexedDB: deps.indexedDB, IDBKeyRange: deps.IDBKeyRange, chromeTransactionDurability: 'strict' }) as RecordDb;
  db.version(SCHEMA_VERSION).stores(SCHEMA_V1);
  return db;
}
