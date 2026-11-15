import Dexie from 'dexie';
import { CipherError, type Envelope, type RowCipher, type Slot } from '../vault/cipher.ts';
import { CHANGE_TAG, type LockedTable } from '../vault/tags.ts';
import { jsonBytes, parseJsonBytes } from './bytes.ts';
import type { Put, RecordCore, Stamp } from './core.ts';
import { SYNCED, type RecordDb } from './db.ts';
import { MIGRATIONS, type PayloadMigration } from './migrations.ts';
import { KEY_FIELDS, LOCKED, OTHER_PLAIN, PAYLOAD_VERSION, openParts, plainOf, rowId, type Fields, type Plain } from './payload.ts';
import type { ChangeRow, DeviceRow } from './rows.ts';
import { gunzip, gzip } from './backup/body.ts';

// The change log (D-25): every change to the record is also written as a sealed line saying what a
// value was, what it became, when the row was first logged, when it changed, and on which device.
// Lines are only ever added, inside the same transaction as the change, and never shown on screen
// (§8 #22). A field that ever sat under the words key is logged under the words key, so the record
// key alone never opens words, past or present.

export const CHANGE_LINE_VERSION = 1;

export type ChangeKind = 'create' | 'update' | 'delete' | 'recreate' | 'baseline' | 'restore' | 'migration' | 'wiped' | 'event';

export interface ChangeLine {
  readonly v: typeof CHANGE_LINE_VERSION;
  readonly kind: ChangeKind;
  /** the row it is about, also kept plain on the stored line; none on an event */
  readonly ref?: string;
  readonly table?: LockedTable;
  /** only the fields that changed, for this line's key */
  readonly field_changes?: Readonly<Record<string, { readonly old?: unknown; readonly new?: unknown }>>;
  /** when the row was first stored: its first line's time, or null for a row from before the log */
  readonly first_logged_at?: number | null;
  readonly changed_at: number;
  readonly device: string;
  /** usage events only */
  readonly event?: object;
  /** what a restore, a migration batch or a wipe was about: counts and versions, never values */
  readonly detail?: Readonly<Record<string, string | number>>;
}

/** The row a line is about: `<table>|<its primary key as text>`. */
export function refOf(table: LockedTable, plain: Plain): string {
  return `${table}|${rowId(table, plain)}`;
}

const isSynced = (table: string): table is LockedTable => (SYNCED as readonly string[]).includes(table);

/** A stored row's primary key, in the shape the table looks it up by. */
function keyOf(table: LockedTable, row: Readonly<Record<string, unknown>>): unknown {
  const fields = KEY_FIELDS[table];
  return fields.length === 1 ? row[fields[0] ?? ''] : fields.map(f => row[f]);
}

/** Brings fields stored at an older payload version up to today's shape, so a new shape never reads as a change. */
function currentShape(table: LockedTable, slot: Slot, fields: Fields, migrations: readonly PayloadMigration[]): Fields {
  const { pv, ...rest } = fields;
  let out: Fields = rest;
  let version = typeof pv === 'number' ? pv : PAYLOAD_VERSION;
  for (const m of migrations) {
    if (m.table !== table || m.slot !== slot || m.from !== version) continue;
    out = m.up(out);
    version++;
  }
  return out;
}

/** A row's values by field, each with the slot it is stored in: `p` plain, or `r` / `w`. */
async function valuesOf(cipher: RowCipher, table: LockedTable, row: Readonly<Record<string, unknown>> | undefined, migrations: readonly PayloadMigration[]) {
  const out = new Map<string, { readonly value: unknown; readonly slot: 'p' | Slot }>();
  if (!row || row.deleted_at !== undefined) return out;
  const plain = plainOf(table, row);
  for (const f of OTHER_PLAIN[table]) if (plain[f] !== undefined) out.set(f, { value: plain[f], slot: 'p' });
  const opened = await openParts(cipher, table, plain, { r: row.r as Envelope | undefined, w: row.w as Envelope | undefined });
  for (const slot of ['r', 'w'] as const) {
    const fields = opened[slot];
    if (!fields) continue;
    for (const [f, value] of Object.entries(currentShape(table, slot, fields, migrations))) {
      if (value !== undefined && (LOCKED[table][slot].includes(f))) out.set(f, { value, slot });
    }
  }
  return out;
}

/** Seals a line: JSON, squeezed, then locked to its own id and slot. */
export async function sealLine(cipher: RowCipher, id: string, slot: Slot, line: ChangeLine): Promise<Envelope> {
  return cipher.seal({ table: CHANGE_TAG, id, slot }, await gzip(jsonBytes(line)));
}

/** Opens a stored line. A line whose plain ref differs from the one sealed inside it is damaged. */
export async function openLine(cipher: RowCipher, row: ChangeRow): Promise<ChangeLine> {
  const slot: Slot = row.w ? 'w' : 'r';
  const env = row[slot];
  if (!env || (row.r && row.w)) throw new CipherError('damaged');
  const bytes = await cipher.open({ table: CHANGE_TAG, id: row.id, slot }, env);
  let line: ChangeLine;
  try {
    line = parseJsonBytes(await gunzip(bytes)) as ChangeLine;
  } catch {
    throw new CipherError('damaged');
  }
  if (line.v > CHANGE_LINE_VERSION) throw new CipherError('newer-app');
  if ((line.ref ?? undefined) !== (row.ref ?? undefined)) throw new CipherError('damaged');
  // the plain time is checked against the sealed one, so moving a line in time is seen (review 4 #4)
  if (row.at !== undefined && row.at !== line.changed_at) throw new CipherError('damaged');
  return line;
}

export interface LogInput {
  readonly db: RecordDb;
  /** passed in, never taken from the session: first run and restore have none */
  readonly cipher: RowCipher;
  readonly puts: readonly Put[];
  readonly stamp: Stamp;
  readonly newId: () => string;
  readonly migrations?: readonly PayloadMigration[];
}

/**
 * The lines for a write's puts: for each put into a synced table, one line per key holding a changed
 * field, sealed. Runs before the transaction opens; the write queue keeps the rows it reads as they
 * are until that transaction commits. A put that changes nothing gets no line. A stored value that
 * won't open throws, so the write stores nothing rather than log a guess.
 */
export async function changeRows(input: LogInput): Promise<ChangeRow[]> {
  const { db, cipher, stamp } = input;
  const migrations = input.migrations ?? MIGRATIONS;
  const out: ChangeRow[] = [];
  // a row put twice in one write is compared with its earlier put, not with storage (review 4 #7)
  const earlier = new Map<string, Readonly<Record<string, unknown>>>();
  for (const put of input.puts) {
    if (!isSynced(put.table)) continue;
    const table = put.table;
    const next = put.row as Readonly<Record<string, unknown>>;
    const ref = refOf(table, plainOf(table, next));
    const stored = earlier.get(ref) ?? (await db.table(table).get(keyOf(table, next) as never)) as Record<string, unknown> | undefined;
    earlier.set(ref, next);
    const kind = stored === undefined ? 'create'
      : next.deleted_at !== undefined ? 'delete'
        : stored.deleted_at !== undefined ? 'recreate' : 'update';
    const [before, after] = await Promise.all([valuesOf(cipher, table, stored, migrations), valuesOf(cipher, table, next, migrations)]);
    const bySlot: Record<Slot, Record<string, { old?: unknown; new?: unknown }>> = { r: {}, w: {} };
    for (const f of new Set([...before.keys(), ...after.keys()])) {
      const old = before.get(f), now = after.get(f);
      if (JSON.stringify(old?.value) === JSON.stringify(now?.value)) continue;
      const slot: Slot = old?.slot === 'w' || now?.slot === 'w' ? 'w' : 'r';
      bySlot[slot][f] = { ...(old !== undefined && { old: old.value }), ...(now !== undefined && { new: now.value }) };
    }
    if (Object.keys(bySlot.r).length === 0 && Object.keys(bySlot.w).length === 0) continue;
    const first = kind === 'create'
      ? stamp.updated_at
      : ((await db.changes.where('[ref+at]').between([ref, Dexie.minKey], [ref, Dexie.maxKey]).first())?.at ?? null);
    for (const slot of ['r', 'w'] as const) {
      const fields = bySlot[slot];
      if (Object.keys(fields).length === 0) continue;
      const id = input.newId();
      const line: ChangeLine = {
        v: CHANGE_LINE_VERSION, kind, ref, table, field_changes: fields, first_logged_at: first, changed_at: stamp.updated_at, device: stamp.updated_by,
      };
      out.push({ id, at: stamp.updated_at, ref, [slot]: await sealLine(cipher, id, slot, line) });
    }
  }
  return out;
}

/** The tables a write's transaction spans once its lines are added. */
export const withLog = <T extends string>(tables: readonly T[]): readonly (T | 'changes')[] =>
  tables.includes('changes' as T) ? tables : [...tables, 'changes'];


// ─── lines that are not about one change: a restore, the baseline, a migration batch ───

/** Device rows: a restore waiting for its line (plain facts only), and whether the baseline is done. */
export const PENDING_RESTORE = 'pending_restore';
export const LOG_BASELINE = 'log_baseline';
export const BASELINE_BATCH = 50;

/** One sealed line under `r`, not about a single row's fields. */
async function soloLine(cipher: RowCipher, id: string, line: ChangeLine): Promise<ChangeRow> {
  return { id, at: line.changed_at, ...(line.ref !== undefined && { ref: line.ref }), r: await sealLine(cipher, id, 'r', line) };
}

/** A migration batch's one line: which migration and how many rows, never the values (design §2.3). */
export function migrationLine(cipher: RowCipher, input: { readonly id: string; readonly migration: string; readonly rows: number; readonly at: number; readonly device: string }): Promise<ChangeRow> {
  return soloLine(cipher, input.id, {
    v: CHANGE_LINE_VERSION, kind: 'migration', changed_at: input.at, device: input.device, detail: { migration: input.migration, rows: input.rows },
  });
}

/**
 * After a restore, the first unlock seals the restore's plain marker into a `restore` line and clears
 * the marker, in one write. Restore itself runs locked, with no key to seal with (review #3).
 */
export function finishRestore(core: RecordCore): Promise<unknown> {
  return core.write({
    tables: ['device'],
    async prepare(s, stamp) {
      const marker = await core.db.device.get(PENDING_RESTORE);
      if (typeof marker?.value !== 'string' || marker.value === '') return { puts: [], apply: () => {}, value: undefined };
      let detail: Record<string, number> = {};
      try { detail = JSON.parse(marker.value) as Record<string, number>; } catch { /* a marker that won't read still gets its line, without facts */ }
      const line = await soloLine(s.cipher, core.newId(), {
        v: CHANGE_LINE_VERSION, kind: 'restore', changed_at: stamp.updated_at, device: stamp.updated_by, detail,
      });
      const cleared: DeviceRow = { key: PENDING_RESTORE, value: '' };
      return { puts: [{ table: 'changes', row: line }, { table: 'device', row: cleared }], apply: () => {}, value: undefined };
    },
  });
}

/**
 * The baseline (reviews #2, #10): every live row with no line at all gets one `baseline` line holding
 * its values as they are, in batches, each its own write. It runs after an upgrade from before the log
 * and after restoring a backup made before it; a ref that already has a line is skipped, so it never
 * writes a line twice, and a stop part-way carries on at the next unlock. Returns the lines written.
 */
export async function runBaseline(core: RecordCore, batch: number = BASELINE_BATCH): Promise<number> {
  const { db } = core;
  if ((await db.device.get(LOG_BASELINE))?.value === 'done') return 0;
  const logged = new Set((await db.changes.orderBy('[ref+at]').keys()).map(k => String((k as unknown as [string, number])[0])));
  const missing: { readonly table: LockedTable; readonly row: Readonly<Record<string, unknown>> }[] = [];
  for (const table of SYNCED) {
    for (const row of (await db.table(table).toArray()) as Record<string, unknown>[]) {
      if (row.deleted_at === undefined && !logged.has(refOf(table, plainOf(table, row)))) missing.push({ table, row });
    }
  }
  let written = 0;
  for (let i = 0; i < missing.length; i += batch) {
    const part = missing.slice(i, i + batch);
    const result = await core.write({
      tables: ['changes'],
      async prepare(s, stamp) {
        const puts: Put[] = [];
        for (const { table, row } of part) {
          const ref = refOf(table, plainOf(table, row));
          if (await db.changes.where('[ref+at]').between([ref, Dexie.minKey], [ref, Dexie.maxKey]).first()) continue;
          const values = await valuesOf(s.cipher, table, row, MIGRATIONS);
          const fields = Object.fromEntries([...values].map(([f, v]) => [f, { new: v.value }]));
          const loggedAt = values.get('logged_at')?.value;
          const id = core.newId();
          const line: ChangeLine = {
            v: CHANGE_LINE_VERSION, kind: 'baseline', ref, table, field_changes: fields,
            first_logged_at: typeof loggedAt === 'number' ? loggedAt : null, changed_at: stamp.updated_at, device: stamp.updated_by,
          };
          // words stay under the words key here too
          const slot: Slot = [...values.values()].some(v => v.slot === 'w') ? 'w' : 'r';
          if (slot === 'w') {
            const r = Object.fromEntries([...values].filter(([, v]) => v.slot !== 'w').map(([f, v]) => [f, { new: v.value }]));
            const w = Object.fromEntries([...values].filter(([, v]) => v.slot === 'w').map(([f, v]) => [f, { new: v.value }]));
            if (Object.keys(r).length > 0) {
              const rid = core.newId();
              puts.push({ table: 'changes', row: { id: rid, at: stamp.updated_at, ref, r: await sealLine(s.cipher, rid, 'r', { ...line, field_changes: r }) } });
            }
            puts.push({ table: 'changes', row: { id, at: stamp.updated_at, ref, w: await sealLine(s.cipher, id, 'w', { ...line, field_changes: w }) } });
          } else {
            puts.push({ table: 'changes', row: { id, at: stamp.updated_at, ref, r: await sealLine(s.cipher, id, 'r', line) } });
          }
        }
        return { puts, apply: () => {}, value: puts.length };
      },
    });
    if (result.kind !== 'Saved') return written;          // locked part-way: the next unlock carries on
    written += result.value;
  }
  await db.device.put({ key: LOG_BASELINE, value: 'done' });
  return written;
}
