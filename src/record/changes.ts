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
import { markRewrite } from './backup/monthLog.ts';

// The change log (D-25): every change to the record is also written as a sealed line saying what a
// value was, what it became, when the row was first logged, when it changed, and on which device.
// Lines are only ever added, inside the same transaction as the change, and never shown on screen
// (§8 #22). A field that ever sat under the words key is logged under the words key, so the record
// key alone never opens words, past or present. The one exception to "only added" is a delete for
// good (D-33, D-35): when the trash wipes an item's words, or a reminder is deleted, the log's copies
// of its words go in the same write.

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

/** The tables the trash empties: only its 7-day sweep leaves a tombstone there. */
const TRASH_TABLES: readonly string[] = ['entries', 'notyet'];

/** The tables whose tombstone is a delete for good: the trash's, and reminders, which have no trash (D-35). */
const WIPE_TABLES: readonly string[] = [...TRASH_TABLES, 'cues'];

/** Whether a row was deleted for good: no line about it keeps words (D-33, D-35). */
export const isWiped = (table: string, row: Readonly<Record<string, unknown>>): boolean =>
  WIPE_TABLES.includes(table) && row.deleted_at !== undefined;

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
    // a wiped row's old words are not written down again: its `wiped` line says how many went
    const wiped = isWiped(table, next);
    for (const slot of ['r', 'w'] as const) {
      const fields = bySlot[slot];
      if (Object.keys(fields).length === 0 || (slot === 'w' && wiped)) continue;
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


// ─── the wipe of a delete for good: the trash's (D-33), a reminder's (D-35) ───

/** A wiped row's lines under the words key, as read before the write's transaction. */
export interface Wipe {
  readonly ref: string;
  readonly ids: readonly string[];
  /** their plain times: the month files holding any of them are sealed again */
  readonly ats: readonly number[];
  /** every words line the row has (the sweep), not only those older than its wipe */
  readonly all: boolean;
}

/** A ref's lines under the words key. */
async function wordLines(db: RecordDb, ref: string): Promise<ChangeRow[]> {
  return (await db.changes.where('[ref+at]').between([ref, Dexie.minKey], [ref, Dexie.maxKey]).toArray()).filter(l => l.w !== undefined);
}

/**
 * For each put that wipes a row: its lines under the words key, to go in the write's transaction, and
 * one `wiped` line under the record key saying how many, with no words. Runs before the transaction;
 * the write queue keeps the log as it is until that transaction commits.
 */
export async function wipeRows(input: LogInput): Promise<{ readonly wipes: readonly Wipe[]; readonly lines: readonly ChangeRow[] }> {
  const { db, cipher, stamp } = input;
  const wipes: Wipe[] = [], lines: ChangeRow[] = [];
  const seen = new Set<string>();
  for (const put of input.puts) {
    const next = put.row as Readonly<Record<string, unknown>>;
    if (!isSynced(put.table) || !isWiped(put.table, next)) continue;
    const table = put.table;
    const ref = refOf(table, plainOf(table, next));
    if (seen.has(ref)) continue;
    seen.add(ref);
    const words = await wordLines(db, ref);
    const stored = (await db.table(table).get(keyOf(table, next) as never)) as Record<string, unknown> | undefined;
    // nothing was there to wipe; a reminder holds words only while private, and then it has words lines
    if (words.length === 0 && (stored === undefined || stored.deleted_at !== undefined || !TRASH_TABLES.includes(table))) continue;
    wipes.push({ ref, ids: words.map(l => l.id), ats: words.flatMap(l => (typeof l.at === 'number' ? [l.at] : [])), all: true });
    lines.push(await soloLine(cipher, input.newId(), {
      v: CHANGE_LINE_VERSION, kind: 'wiped', ref, table, changed_at: stamp.updated_at, device: stamp.updated_by, detail: { lines: words.length },
    }));
  }
  return { wipes, lines };
}

/**
 * Inside the write's transaction, the log's only delete: each wiped row's words lines go, once they
 * are checked to be exactly the ones read (anything else aborts the write), and the month files that
 * hold any of them are marked to be sealed again without them.
 */
export async function wipeLines(db: RecordDb, wipes: readonly Wipe[]): Promise<void> {
  for (const wipe of wipes) {
    const now = new Set((await wordLines(db, wipe.ref)).map(l => l.id));
    if (wipe.ids.some(id => !now.has(id)) || (wipe.all && now.size !== wipe.ids.length)) throw new Error('the log changed while a wipe was prepared');
    await db.changes.bulkDelete([...wipe.ids]);
  }
  await markRewrite(db, wipes.flatMap(w => w.ats));
}

/**
 * The lines a backup still holds under the words key about rows it says were deleted for good: a copy made
 * before a month file was sealed again carries them. A restore leaves them out, so a wipe stays a wipe.
 */
export function wipedLeftovers(tables: Readonly<Record<string, readonly unknown[]>>, lines: readonly ChangeRow[]): ChangeRow[] {
  const wiped = new Set<string>();
  for (const table of WIPE_TABLES) {
    for (const row of (tables[table] ?? []) as readonly Record<string, unknown>[]) {
      if (isWiped(table, row)) wiped.add(refOf(table as LockedTable, plainOf(table as LockedTable, row)));
    }
  }
  return wiped.size === 0 ? [] : lines.filter(l => l.w !== undefined && l.ref !== undefined && wiped.has(l.ref));
}

/** Device row: whether the record has been checked for words a delete for good wiped; a restore clears it. */
export const LOG_WIPE_CHECK = 'log_wipe_check';

/** Its value once checked. It names the tables checked, so a table joining the rule is checked once more. */
export const LOG_WIPE_CHECKED = `done:${WIPE_TABLES.join(',')}`;

/**
 * Once after an upgrade and at the first unlock after any restore, with the keys open: wipes the words
 * lines a delete for good says are gone but the record still holds. Those of a tombstoned page, item
 * or reminder (deleted by a build from before the log followed it, or brought by a copy made before
 * its month file was cleaned), and any older than a `wiped` line about the same row (an id saved
 * again after its wipe, which no row state shows). One write, through the sweep's own wipe, so the
 * month files holding them are marked too. Returns how many rows it cleaned.
 */
export async function cleanWiped(core: RecordCore): Promise<number> {
  const { db } = core;
  if ((await db.device.get(LOG_WIPE_CHECK))?.value === LOG_WIPE_CHECKED) return 0;
  const result = await core.write({
    tables: ['changes'],
    async prepare(s, stamp) {
      const tombstoned = new Set<string>();
      const lines: ChangeRow[] = [];
      for (const table of WIPE_TABLES) {
        for (const row of (await db.table(table).toArray()) as Record<string, unknown>[]) {
          if (isWiped(table, row)) tombstoned.add(refOf(table as LockedTable, plainOf(table as LockedTable, row)));
        }
        lines.push(...await db.changes.where('[ref+at]').between([`${table}|`, Dexie.minKey], [`${table}|￿`, Dexie.maxKey]).toArray());
      }
      // when each row was last wiped: only its `wiped` line says so, and only from inside its seal
      const wipedAt = new Map<string, number>();
      for (const row of lines) {
        if (row.r === undefined || row.ref === undefined) continue;
        try {
          const line = await openLine(s.cipher, row);
          if (line.kind === 'wiped') wipedAt.set(row.ref, Math.max(wipedAt.get(row.ref) ?? -Infinity, line.changed_at));
        } catch {
          // a line that won't open says nothing here, and must not stop the unlock
        }
      }
      const byRef = new Map<string, ChangeRow[]>();
      for (const row of lines) {
        if (row.w === undefined || row.ref === undefined) continue;
        const at = wipedAt.get(row.ref);
        if (tombstoned.has(row.ref) || (at !== undefined && (row.at ?? -Infinity) < at)) byRef.set(row.ref, [...(byRef.get(row.ref) ?? []), row]);
      }
      const wipes: Wipe[] = [], puts: Put[] = [];
      for (const [ref, rows] of byRef) {
        wipes.push({ ref, ids: rows.map(l => l.id), ats: rows.flatMap(l => (typeof l.at === 'number' ? [l.at] : [])), all: tombstoned.has(ref) });
        puts.push({ table: 'changes', row: await soloLine(s.cipher, core.newId(), {
          v: CHANGE_LINE_VERSION, kind: 'wiped', ref, table: ref.slice(0, ref.indexOf('|')) as LockedTable,
          changed_at: stamp.updated_at, device: stamp.updated_by, detail: { lines: rows.length },
        }) });
      }
      return { puts, wipes, apply: () => {}, value: wipes.length };
    },
  });
  if (result.kind !== 'Saved') return 0;                   // locked or full: the next unlock tries again
  await db.device.put({ key: LOG_WIPE_CHECK, value: LOG_WIPE_CHECKED });
  return result.value;
}


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
