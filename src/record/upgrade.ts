import Dexie from 'dexie';
import { jsonBytes } from './bytes.ts';
import { openDb, SCHEMAS, upgradeRow, type RecordDb, type Schema, type StorageDeps } from './db.ts';
import type { SnapshotFiles } from './files.ts';
import { gzip } from './backup/body.ts';
import { PREUPGRADE, SAFETY, keepCopy, pruneCopies } from './backup/copies.ts';

// Opening storage at app start. A database written by a newer app is refused, never opened. Before
// a schema upgrade, a raw copy of every row is kept privately; the upgrade itself touches only
// plain fields, because the app is still locked and can't decrypt.

export type StorageResult = { readonly kind: 'Ready'; readonly db: RecordDb } | { readonly kind: 'AppTooOld' };

/** The installed database, opened as it is, or undefined on a new phone. */
async function installed(deps: StorageDeps): Promise<Dexie | undefined> {
  const probe = new Dexie(deps.name, { indexedDB: deps.indexedDB, IDBKeyRange: deps.IDBKeyRange });
  try {
    await probe.open();
    return probe;
  } catch (e) {
    if (e instanceof Error && e.name === 'NoSuchDatabaseError') return undefined;
    throw e;
  }
}

/** Every row of every table but `device`, as gzip of UTF-8 JSON. Locked values stay locked. */
async function rawCopy(db: Dexie): Promise<Uint8Array> {
  const names = db.tables.map(t => t.name).filter(name => name !== 'device').sort();
  const tables = await db.transaction('r', names.map(name => db.table(name)), async () =>
    Object.fromEntries(await Promise.all(names.map(async name => [name, await db.table(name).toArray()] as const))));
  return gzip(jsonBytes({ schema_version: db.verno, tables }));
}

/**
 * Opens storage. Refuses a database from a newer app (Dexie would open it without a word); keeps a
 * raw copy before an upgrade; removes private copies past their 7 days.
 */
export async function openStorage(deps: StorageDeps, files: SnapshotFiles, now: () => number, schemas: readonly Schema[] = SCHEMAS): Promise<StorageResult> {
  const latest = schemas[schemas.length - 1]?.version ?? 0;
  const probe = await installed(deps);
  if (probe) {
    try {
      if (probe.verno > latest) return { kind: 'AppTooOld' };
      if (probe.verno < latest) await keepCopy(files, PREUPGRADE, now(), 'json.gz', await rawCopy(probe));
    } finally {
      probe.close();                    // an open connection would block the upgrade
    }
  }
  await pruneCopies(files, PREUPGRADE, now());
  await pruneCopies(files, SAFETY, now());
  const db = openDb(deps, schemas);
  await db.open();
  return { kind: 'Ready', db };
}

/** Brings rows written under an older schema up to the latest, with the same pure functions an upgrade uses. */
export function upgradeTables<T extends Readonly<Record<string, readonly object[]>>>(tables: T, from: number, schemas: readonly Schema[] = SCHEMAS): T {
  let out: Record<string, readonly object[]> = { ...tables };
  for (const schema of schemas) {
    if (schema.version <= from || !schema.upgrade) continue;
    for (const [table, change] of Object.entries(schema.upgrade)) {
      const rows = out[table];
      if (rows) out = { ...out, [table]: rows.map(row => upgradeRow(change, row as Readonly<Record<string, unknown>>)) };
    }
  }
  return out as T;
}
