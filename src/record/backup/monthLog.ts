import { BackupError } from '../../vault/cipher.ts';
import type { RecordCore, Session } from '../core.ts';
import { SCHEMA_VERSION, type RecordDb } from '../db.ts';
import type { SnapshotFiles } from '../files.ts';
import type { ChangeRow } from '../rows.ts';
import { jsonBytes, parseJsonBytes, toBase64url } from '../bytes.ts';
import { appDay, todayOf } from '../time.ts';
import { gzip } from './body.ts';
import type { BackupOptions } from './export.ts';
import { FORMAT_VERSION, LOG_FORMAT, frame, headerBytes, type BackupHeader } from './format.ts';

// The change log, month by month (design §2.4). The automatic copy carries only the lines of the
// current month; each finished month is sealed once into backup/log/YYYY-MM.dclog, which Android's
// backup carries too. One rule holds at every moment: every line is in latest.dcbak or in a month
// file. A plain cursor on this device says which lines the month files hold (every line before
// `before`); a new line is always stamped after every stored one, so it never falls behind it.

export const LOG_DIR = 'backup/log';
/** Device row: the cursor, as JSON; restore resets it to `reset:<id>`. */
export const LOG_ARCHIVE = 'log_archive';
const TMP = 'tmp/month.dclog';
const NAME = /^\d{4}-\d{2}\.dclog$/;

export interface LogCursor {
  /** the app month whose lock wrote the newest month file */
  readonly month: string;
  /** every line with `at` before this is in a month file */
  readonly before: number;
  /** the newest month file; a cursor whose file isn't there is not trusted */
  readonly file: string;
}

/** A month file sealed at lock, waiting to be written once the keys are gone. */
export interface SealedMonth {
  readonly name: string;
  readonly bytes: Uint8Array;
  /** the cursor once the file is written */
  readonly cursor: LogCursor;
  /** the cursor row as it was read; it moves only if it is still that (a restore in between wins) */
  readonly expected: string | undefined;
}

function parseCursor(raw: unknown): LogCursor | undefined {
  if (typeof raw !== 'string') return undefined;
  try {
    const c = JSON.parse(raw) as Partial<LogCursor>;
    return typeof c.month === 'string' && typeof c.before === 'number' && typeof c.file === 'string' ? { month: c.month, before: c.before, file: c.file } : undefined;
  } catch {
    return undefined;
  }
}

const monthOf = (ms: number, session: Session): string => appDay(ms, session.model.settings).slice(0, 7);

/**
 * At a lock that seals a snapshot: where the snapshot's lines start, and the month file to write
 * if a new app month has begun since the last one. The snapshot sealed at that lock still starts at
 * the old cursor; only once the month file is written does the cursor move.
 */
export async function sealMonth(db: RecordDb, session: Session, files: SnapshotFiles, now: number, options: BackupOptions): Promise<{ readonly logFrom: number; readonly month?: SealedMonth }> {
  const raw = (await db.device.get(LOG_ARCHIVE))?.value;
  const expected = raw === undefined ? undefined : String(raw);
  const names = (await files.list(LOG_DIR)).filter(n => NAME.test(n));
  const read = parseCursor(raw);
  const cursor = read && names.includes(read.file) ? read : undefined;
  const from = cursor?.before ?? -Infinity;
  const month = todayOf(now, session.lastWriteMs, session.model.settings).slice(0, 7);
  if (cursor && cursor.month >= month) return { logFrom: from };
  // the archive ends at the newest line from an earlier month. The lines come oldest first (whole
  // rows: reading only the keys is far slower in some stores), and under one day rule a later
  // instant is never in an earlier month, so a binary search finds it with a dozen date lookups,
  // not one per line (each lookup builds a formatter)
  const since = await db.changes.where('at').aboveOrEqual(from).toArray();
  let lo = 0, hi = since.length;                            // since[0..lo) are earlier months, since[hi..) are not
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (monthOf(since[mid]?.at ?? 0, session) < month) lo = mid + 1;
    else hi = mid;
  }
  const last = lo === 0 ? undefined : since[lo - 1]?.at;
  if (last === undefined) return { logFrom: from };
  const name = `${monthOf(last, session)}.dclog`;
  if (names.includes(name)) return { logFrom: from };     // written once: a name already there waits for the next month's
  // every line before `last + 1` (a line sharing its `at` shares its month, so it is before `lo` too), in id order
  const lines = since.slice(0, lo).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const bytes = await sealLines(db, session, lines, now, options);
  return { logFrom: from, month: { name, bytes, cursor: { month, before: last + 1, file: name }, expected } };
}

/** A month file: the backup's frame and header, its body the lines exactly as stored. */
async function sealLines(db: RecordDb, session: Session, lines: readonly ChangeRow[], now: number, options: BackupOptions): Promise<Uint8Array> {
  const backup = session.backup;
  if (!backup) throw new Error('this session has no backup key');
  const vault = await db.vault.get('main');
  const wrappers = await db.wrappers.toArray();
  const passphrase = wrappers.find(w => w.method === 'passphrase');
  const recovery = wrappers.find(w => w.method === 'recovery');
  if (!vault || !passphrase || !recovery) throw new Error('the vault is incomplete');
  const iv = options.iv ?? crypto.getRandomValues(new Uint8Array(12));
  const header: BackupHeader = {
    format: LOG_FORMAT, format_version: FORMAT_VERSION, schema_version: SCHEMA_VERSION, app_version: options.appVersion,
    exported_at: Math.max(now, session.lastWriteMs ?? now),
    vault_id: vault.vault_id, kid: vault.kid, generation: vault.generation, iv: toBase64url(iv),
    wrappers: { passphrase, recovery },
  };
  const head = headerBytes(header);
  return frame(head, await backup.sealBody(await gzip(jsonBytes({ changes: lines })), head, iv));
}

/** A month file's body back to its lines; anything else is damaged. */
export function parseMonth(bytes: Uint8Array): readonly ChangeRow[] {
  let value: unknown;
  try {
    value = parseJsonBytes(bytes);
  } catch {
    throw new BackupError('damaged');
  }
  const lines = typeof value === 'object' && value !== null && Object.keys(value).join() === 'changes' ? (value as { changes: unknown }).changes : undefined;
  if (!Array.isArray(lines) || !lines.every(l => typeof l === 'object' && l !== null && !Array.isArray(l))) throw new BackupError('damaged');
  return lines as ChangeRow[];
}

/** Writes a sealed month through tmp/, never over a file already there. False when it wasn't written. */
export async function writeMonth(files: SnapshotFiles, month: SealedMonth): Promise<boolean> {
  if ((await files.list(LOG_DIR)).includes(month.name)) return false;
  await files.write(TMP, month.bytes);
  await files.rename(TMP, `${LOG_DIR}/${month.name}`);
  return true;
}

/**
 * Moves the cursor past a month just written, in the write queue, and only if the cursor row is
 * still what the lock read: a restore in between has reset it, and its record is not this file's.
 */
export function advanceCursor(core: RecordCore, month: SealedMonth): Promise<boolean> {
  const { db } = core;
  return core.serial(() => db.transaction('rw', db.device, async () => {
    const now = (await db.device.get(LOG_ARCHIVE))?.value;
    if ((now === undefined ? undefined : String(now)) !== month.expected) return false;
    await db.device.put({ key: LOG_ARCHIVE, value: JSON.stringify(month.cursor) });
    return true;
  }));
}

/** Every month file on this phone, oldest first; one that can't be read is left out. */
export async function readMonths(files: SnapshotFiles): Promise<Uint8Array[]> {
  const out: Uint8Array[] = [];
  for (const name of (await files.list(LOG_DIR)).filter(n => NAME.test(n)).sort()) {
    const bytes = await files.read(`${LOG_DIR}/${name}`).catch(() => undefined);
    if (bytes) out.push(bytes);
  }
  return out;
}

/** Removes every month file: after a restore they describe the record that was replaced. */
export async function clearMonths(files: SnapshotFiles): Promise<void> {
  for (const name of await files.list(LOG_DIR)) await files.remove(`${LOG_DIR}/${name}`);
}
