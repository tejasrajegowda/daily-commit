import { BackupError } from '../../vault/cipher.ts';
import { jsonBytes, parseJsonBytes } from '../bytes.ts';
import { SCHEMA_VERSION, type RecordDb } from '../db.ts';
import type { WrapperRow } from '../rows.ts';

// A backup's body: every table a restore needs, in a fixed order, each row exactly as stored and
// in primary-key order, so the same record always makes the same bytes. `device` and `migrations`
// stay on this phone; the wrappers travel in the header instead. Which tables a body holds follows
// the header's schema version: version 2 adds the change log at the end.

export const BODY_TABLES_V1 = ['vault', 'settings', 'habits', 'observations', 'days', 'entries', 'notyet', 'cues', 'reviews'] as const;
export const BODY_TABLES = [...BODY_TABLES_V1, 'changes'] as const;
export type BodyTable = (typeof BODY_TABLES)[number];
export type StoredRows = Readonly<Record<BodyTable, readonly object[]>>;

/** The tables a body of this schema version holds, in order. */
export function bodyTables(schemaVersion: number): readonly BodyTable[] {
  return schemaVersion >= 2 ? BODY_TABLES : BODY_TABLES_V1;
}

export interface RawRecord {
  readonly tables: StoredRows;
  readonly wrappers: readonly WrapperRow[];
}

/** Every body table and the wrappers, in one read transaction, so they all agree. */
export function readRaw(db: RecordDb): Promise<RawRecord> {
  return db.transaction('r', [...BODY_TABLES, 'wrappers'].map(t => db.table(t)), async () => {
    const rows = await Promise.all(BODY_TABLES.map(t => db.table(t).toArray()));
    const wrappers = await db.wrappers.toArray();
    return { tables: Object.fromEntries(BODY_TABLES.map((t, i) => [t, rows[i] ?? []])) as unknown as StoredRows, wrappers };
  });
}

/** The body's plain bytes: UTF-8 JSON `{tables: {…}}`, the tables of that schema version in their fixed order. */
export function bodyJson(tables: StoredRows, schemaVersion: number = SCHEMA_VERSION): Uint8Array {
  return jsonBytes({ tables: Object.fromEntries(bodyTables(schemaVersion).map(t => [t, tables[t]])) });
}

/**
 * A body's bytes back to its tables, read as the body of its header's schema version. Anything that
 * isn't exactly such a body is damaged. A body from before the change log comes back with none.
 */
export function parseBody(bytes: Uint8Array, schemaVersion: number): StoredRows {
  let value: unknown;
  try {
    value = parseJsonBytes(bytes);
  } catch {
    throw new BackupError('damaged');
  }
  const tables = typeof value === 'object' && value !== null ? (value as { tables?: unknown }).tables : undefined;
  if (typeof tables !== 'object' || tables === null || Object.keys(tables).join() !== bodyTables(schemaVersion).join()) throw new BackupError('damaged');
  for (const rows of Object.values(tables)) {
    if (!Array.isArray(rows) || !rows.every(row => typeof row === 'object' && row !== null && !Array.isArray(row))) throw new BackupError('damaged');
  }
  return (schemaVersion >= 2 ? tables : { ...tables, changes: [] }) as StoredRows;
}

async function through(bytes: Uint8Array, stream: CompressionStream | DecompressionStream): Promise<Uint8Array> {
  // a copy, so the Blob gets bytes backed by their own ArrayBuffer
  const out = new Blob([bytes.slice()]).stream().pipeThrough(stream);
  return new Uint8Array(await new Response(out).arrayBuffer());
}

/** gzip, through the platform's CompressionStream. */
export const gzip = (bytes: Uint8Array): Promise<Uint8Array> => through(bytes, new CompressionStream('gzip'));

/** The other way; bytes that aren't gzip, or are cut short, are damaged. */
export async function gunzip(bytes: Uint8Array): Promise<Uint8Array> {
  try {
    return await through(bytes, new DecompressionStream('gzip'));
  } catch {
    throw new BackupError('damaged');
  }
}
