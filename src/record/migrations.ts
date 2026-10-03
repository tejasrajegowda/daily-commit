import type { Envelope, RowCipher, Slot } from '../vault/cipher.ts';
import { TABLE_TAGS, type LockedTable } from '../vault/tags.ts';
import { jsonBytes, parseJsonBytes } from './bytes.ts';
import type { RecordCore } from './core.ts';
import { KEY_FIELDS, plainOf, rowId, type Fields } from './payload.ts';

// Changes to the shape of locked values, made after unlock, row by row. Each one reads values of
// one payload version and writes the next. Progress is saved with each batch, so a stop part-way
// carries on where it was; a row already at the new version is skipped, so nothing is changed
// twice, even after a restore.

export interface PayloadMigration {
  /** permanent: its progress is kept under this id */
  readonly id: string;
  readonly table: LockedTable;
  readonly slot: Slot;
  /** the payload version it reads; it writes the next one */
  readonly from: number;
  /** the new fields, from the old ones (without pv) */
  readonly up: (fields: Fields) => Fields;
}

/** Schema v1 has none. Each new one is added at the end, in order, and never edited. */
export const MIGRATIONS: readonly PayloadMigration[] = [];
export const MIGRATION_BATCH = 50;

function primaryKey(table: LockedTable, row: Readonly<Record<string, unknown>>): unknown {
  const fields = KEY_FIELDS[table];
  return fields.length === 1 ? row[fields[0] ?? ''] : fields.map(field => row[field]);
}

/** One batch, in one turn of the write queue: read, change outside any transaction, then write rows and cursor together. */
async function migrateBatch(core: RecordCore, cipher: RowCipher, m: PayloadMigration, batch: number): Promise<{ readonly changed: number; readonly done: boolean }> {
  const { db } = core;
  const progress = await db.migrations.get(m.id);
  if (progress?.done_at !== undefined) return { changed: 0, done: true };
  const table = db.table(m.table);
  const pending = progress?.cursor === undefined ? table.orderBy(':id') : table.where(':id').above(JSON.parse(progress.cursor));
  const rows = (await pending.limit(batch).toArray()) as Record<string, unknown>[];
  const puts: Record<string, unknown>[] = [];
  for (const row of rows) {
    const env = row[m.slot] as Envelope | undefined;
    if (row.deleted_at !== undefined || env === undefined) continue;
    const ctx = { table: TABLE_TAGS[m.table], id: rowId(m.table, plainOf(m.table, row)), slot: m.slot };
    const { pv, ...fields } = parseJsonBytes(await cipher.open(ctx, env)) as Fields;
    if (pv !== m.from) continue;
    puts.push({ ...row, [m.slot]: await cipher.seal(ctx, jsonBytes({ ...m.up(fields), pv: m.from + 1 })) });
  }
  const last = rows[rows.length - 1];
  const done = rows.length < batch;
  await db.transaction('rw', [table, db.migrations], async () => {
    for (const row of puts) await table.put(row);
    await db.migrations.put(done || last === undefined ? { id: m.id, done_at: core.now() } : { id: m.id, cursor: JSON.stringify(primaryKey(m.table, last)) });
  });
  return { changed: puts.length, done };
}

/** Runs every change not yet done, in order. Returns how many values were changed. */
export async function runMigrations(core: RecordCore, cipher: RowCipher, list: readonly PayloadMigration[] = MIGRATIONS, batch = MIGRATION_BATCH): Promise<number> {
  let changed = 0;
  for (const m of list) {
    for (;;) {
      const step = await core.serial(() => migrateBatch(core, cipher, m, batch));
      changed += step.changed;
      if (step.done) break;
    }
  }
  return changed;
}
