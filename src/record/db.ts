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

/** A plain-field change made by a schema upgrade: a pure function over one stored row. */
export type PlainUpgrade = (row: Readonly<Record<string, unknown>>) => Record<string, unknown>;

/** One schema version: its tables, and how rows written under the version before it change. */
export interface Schema {
  readonly version: number;
  readonly stores: Readonly<Record<string, string | null>>;
  readonly upgrade?: Readonly<Record<string, PlainUpgrade>>;
}

/** Every schema version, oldest first. A new version is added at the end, never edited. */
export const SCHEMAS: readonly Schema[] = [{ version: SCHEMA_VERSION, stores: SCHEMA_V1 }];

/** Applies a plain upgrade to one row. An upgrade runs while the app is locked, so touching a locked value is a mistake. */
export function upgradeRow(change: PlainUpgrade, row: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const next = change(row);
  if (next.r !== row.r || next.w !== row.w) throw new Error('a schema upgrade may not touch a locked value');
  return next;
}

/**
 * Opens the record's database. Every write waits until it is on disk ("strict"), because Chrome's
 * relaxed default reports a save before the data is safe. The app opens it through openStorage.
 */
export function openDb(deps: StorageDeps, schemas: readonly Schema[] = SCHEMAS): RecordDb {
  const db = new Dexie(deps.name, { indexedDB: deps.indexedDB, IDBKeyRange: deps.IDBKeyRange, chromeTransactionDurability: 'strict' }) as RecordDb;
  for (const schema of schemas) {
    const version = db.version(schema.version).stores({ ...schema.stores });
    const upgrade = schema.upgrade;
    if (upgrade) {
      version.upgrade(async tx => {
        for (const [table, change] of Object.entries(upgrade)) {
          await tx.table(table).toCollection().modify((row: Record<string, unknown>, ctx: { value: Record<string, unknown> }) => {
            ctx.value = upgradeRow(change, row);
          });
        }
      });
    }
  }
  return db;
}
