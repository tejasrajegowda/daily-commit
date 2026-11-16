import { BackupError } from '../../vault/cipher.ts';
import type { RecordCore, Session } from '../core.ts';
import { SCHEMA_VERSION, type RecordDb } from '../db.ts';
import type { SnapshotFiles } from '../files.ts';
import type { ChangeRow } from '../rows.ts';
import { jsonBytes, parseJsonBytes, toBase64url } from '../bytes.ts';
import { appDay, todayOf } from '../time.ts';
import { gzip } from './body.ts';
import { REPLACED } from './copies.ts';
import type { BackupOptions } from './export.ts';
import { FORMAT_VERSION, LOG_FORMAT, frame, headerBytes, type BackupHeader, type LogFile } from './format.ts';

// The change log, month by month (design §2.4). The database keeps every line; a month file in
// backup/log/ is a sealed copy of the lines in one `at` range, so it is never opened again: when
// one is missing it is simply made again from the database. A plain cursor on this device says
// which ranges are in files (`ranges`) and where the lines the automatic copy carries begin
// (`before`). A new line is always stamped after every stored one, so it never falls behind it.
// What the phone's copy relies on is bound into its header: each month file's name and digest.
// When the trash wipes words a month file holds (D-33), that file is sealed again from the database
// under a new name; the old one is removed once a latest naming the new one is on disk, so the
// phone's copy never names a file that is gone.

export const LOG_DIR = 'backup/log';
/** Device row: the cursor, as JSON. */
export const LOG_ARCHIVE = 'log_archive';
/** At most this many month files are sealed at one lock, so a lock always fits its time. */
export const MONTHS_A_LOCK = 3;
const TMP = 'tmp/month.dclog';
const NAME = /^\d{4}-\d{2}(?:\.\d+)?\.dclog$/;

export interface LogRange {
  readonly name: string;
  /** its lines are those with `from <= at < before` */
  readonly from: number;
  readonly before: number;
  readonly sha256: string;
}

export interface LogCursor {
  /** new at every restore, so a lock sealed before it can tell the record was replaced */
  readonly gen: string;
  /** lines with `at` before this are in month files; null: none are */
  readonly before: number | null;
  readonly ranges: readonly LogRange[];
  /** listed files that still hold words a delete for good wiped: each is sealed again under a new name */
  readonly rewrite: readonly string[];
  /** files a rewrite replaced: removed once a latest naming their replacements is written */
  readonly retired: readonly string[];
  /** retired files whose removal failed: tried again after each latest written, never a reason to write one */
  readonly unremoved: readonly string[];
}

export const NO_CURSOR: LogCursor = { gen: '', before: null, ranges: [], rewrite: [], retired: [], unremoved: [] };

const names = (x: unknown): readonly string[] | undefined =>
  x === undefined ? [] : Array.isArray(x) && x.every(s => typeof s === 'string') ? x : undefined;

export function parseCursor(raw: unknown): LogCursor {
  if (typeof raw !== 'string') return NO_CURSOR;
  try {
    const c = JSON.parse(raw) as Partial<LogCursor>;
    const ranges = Array.isArray(c.ranges) && c.ranges.every(r => typeof r?.name === 'string' && typeof r.from === 'number' && typeof r.before === 'number' && typeof r.sha256 === 'string') ? c.ranges : undefined;
    const rewrite = names(c.rewrite), retired = names(c.retired), unremoved = names(c.unremoved);
    if (typeof c.gen !== 'string' || !(c.before === null || typeof c.before === 'number') || !ranges || !rewrite || !retired || !unremoved) return NO_CURSOR;
    return { gen: c.gen, before: c.before, ranges, rewrite, retired, unremoved };
  } catch {
    return NO_CURSOR;
  }
}

export const cursorValue = (c: LogCursor): string =>
  JSON.stringify({ gen: c.gen, before: c.before, ranges: c.ranges, rewrite: c.rewrite, retired: c.retired, unremoved: c.unremoved });

/** Files that may hold wiped words, so they are removed, never kept aside: waiting to be sealed again, replaced, or not yet removed. */
const wordyFiles = (c: LogCursor): readonly string[] => [...c.rewrite, ...c.retired, ...c.unremoved];

/** Inside a wipe's transaction: the listed month files holding a line at any of these times are to be sealed again. */
export async function markRewrite(db: RecordDb, ats: readonly number[]): Promise<void> {
  const c = parseCursor((await db.device.get(LOG_ARCHIVE))?.value);
  const add = c.ranges.filter(r => !c.rewrite.includes(r.name) && ats.some(at => r.from <= at && at < r.before)).map(r => r.name);
  if (add.length > 0) await db.device.put({ key: LOG_ARCHIVE, value: cursorValue({ ...c, rewrite: [...c.rewrite, ...add] }) });
}

/** Month work a lock does even when nothing changed: a file still holding wiped words, or a replaced file still there. */
export async function monthsPending(db: RecordDb): Promise<boolean> {
  const c = parseCursor((await db.device.get(LOG_ARCHIVE))?.value);
  return c.retired.length > 0 || c.rewrite.some(name => c.ranges.some(r => r.name === name));
}

/**
 * A month file sealed at lock, waiting to be written once the keys are gone: a new range of lines, one
 * whose file had gone and was made again, or one sealed again without wiped words. Or a range the
 * trash left with no lines at all: dropped, its file removed like a replaced one.
 */
export type SealedMonth =
  | { readonly kind: 'archive' | 'rebuild' | 'rewrite'; readonly range: LogRange; readonly bytes: Uint8Array; readonly replaces?: string }
  | { readonly kind: 'drop'; readonly replaces: string };

/** The month work of one lock, filled in as it is sealed, so a lock past its time still keeps what finished. */
export interface MonthWork {
  /** the cursor row as read; the files are written only if it is still that */
  expected: string | undefined;
  base: LogCursor;
  readonly sealed: SealedMonth[];
}

export const monthWork = (): MonthWork => ({ expected: undefined, base: NO_CURSOR, sealed: [] });

export const digestOf = async (bytes: Uint8Array): Promise<string> =>
  toBase64url(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes.slice())));

const byId = (a: ChangeRow, b: ChangeRow) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/**
 * At a lock that seals a snapshot: seals up to three month files (first any listed file that has gone,
 * then any that still holds wiped words, then the finished app months not yet in a file, oldest
 * first), and says where the snapshot's lines start and which files its header names, as they will be
 * once these are written.
 */
export async function sealMonths(db: RecordDb, session: Session, files: SnapshotFiles, now: number, options: BackupOptions, work: MonthWork): Promise<{ readonly from: number; readonly files: readonly LogFile[] }> {
  const raw = (await db.device.get(LOG_ARCHIVE))?.value;
  work.expected = raw === undefined ? undefined : String(raw);
  const base = parseCursor(raw);
  work.base = base;
  let names: Set<string>;
  try {
    names = new Set(await files.list(LOG_DIR));
  } catch {
    return { from: -Infinity, files: [] };                  // nothing can be vouched for: the snapshot carries every line
  }
  let budget = MONTHS_A_LOCK;
  let ranges = new Map(base.ranges.map(r => [r.name, r]));
  const linesOf = async (r: LogRange) => (await db.changes.where('at').between(r.from, r.before, true, false).toArray()).sort(byId);
  let unbuilt = Infinity;                                   // the oldest listed range still missing after this lock
  for (const r of base.ranges.filter(r => !names.has(r.name)).sort((a, b) => a.from - b.from)) {
    if (budget === 0) { unbuilt = Math.min(unbuilt, r.from); continue; }
    budget--;
    const lines = await linesOf(r);
    if (lines.length === 0) {
      ranges.delete(r.name);
      work.sealed.push({ kind: 'drop', replaces: r.name });
      continue;
    }
    const sealed = await sealLines(db, session, lines, options);
    const range: LogRange = { ...r, sha256: sealed.sha256 };
    ranges.set(r.name, range);
    work.sealed.push({ range, bytes: sealed.bytes, kind: 'rebuild' });
  }
  // files still holding wiped words: sealed again from the database, which no longer has them, under a
  // new name, so the file the last latest names stays exactly as it was until a new latest is written
  const taken = new Set([...names, ...ranges.keys(), ...base.retired, ...base.unremoved]);
  for (const name of base.rewrite) {
    const r = ranges.get(name);
    if (budget === 0 || !r || !names.has(name)) continue;  // one that has gone was just made again from the database
    budget--;
    const lines = await linesOf(r);
    if (lines.length === 0) {                               // the wiped words were all it held
      ranges.delete(name);
      work.sealed.push({ kind: 'drop', replaces: name });
      continue;
    }
    const sealed = await sealLines(db, session, lines, options);
    const fresh = freeName(name.slice(0, 7), taken);
    taken.add(fresh);
    const range: LogRange = { ...r, name: fresh, sha256: sealed.sha256 };
    ranges = new Map([...ranges].map(([k, v]) => (k === name ? [fresh, range] : [k, v])));
    work.sealed.push({ range, bytes: sealed.bytes, kind: 'rewrite', replaces: name });
  }
  // the finished months not yet in a file: under one day rule a later instant is never in an earlier
  // month, so each month's end is found by a binary search, a dozen date lookups, not one per line
  let before = base.before;
  const current = todayOf(now, session.lastWriteMs, session.model.settings).slice(0, 7);
  const monthOf = (at: number) => appDay(at, session.model.settings).slice(0, 7);
  const first = await db.changes.where('at').aboveOrEqual(before ?? -Infinity).first();
  if (budget > 0 && first?.at !== undefined && monthOf(first.at) < current) {
    // whole rows, oldest first: reading only the keys is far slower in some stores
    const since = await db.changes.where('at').aboveOrEqual(before ?? -Infinity).toArray();
    for (let i = 0; budget > 0 && i < since.length && monthOf(since[i]?.at ?? 0) < current; budget--) {
      const month = monthOf(since[i]?.at ?? 0);
      let lo = i + 1, hi = since.length;                    // since[i..lo) are this month or earlier
      while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (monthOf(since[mid]?.at ?? 0) <= month) lo = mid + 1;
        else hi = mid;
      }
      const group = since.slice(i, lo);
      const name = freeName(month, taken);
      taken.add(name);
      const end = (group[group.length - 1]?.at ?? 0) + 1;
      const sealed = await sealLines(db, session, group.sort(byId), options);
      const range: LogRange = { name, from: since[i]?.at ?? 0, before: end, sha256: sealed.sha256 };
      ranges.set(name, range);
      work.sealed.push({ range, bytes: sealed.bytes, kind: 'archive' });
      before = end;
      i = lo;
    }
  }
  return { from: Math.min(before ?? -Infinity, unbuilt), files: [...ranges.values()].map(r => ({ name: r.name, sha256: r.sha256 })) };
}

/** `YYYY-MM.dclog`, or `YYYY-MM.2.dclog` and on when that name is taken (a clock that jumped, a changed day rule). */
function freeName(month: string, taken: ReadonlySet<string>): string {
  if (!taken.has(`${month}.dclog`)) return `${month}.dclog`;
  for (let n = 2; ; n++) if (!taken.has(`${month}.${n}.dclog`)) return `${month}.${n}.dclog`;
}

/** A month file: the backup's frame and header, its body the lines exactly as stored, under a fresh IV. */
async function sealLines(db: RecordDb, session: Session, lines: readonly ChangeRow[], options: BackupOptions): Promise<{ readonly bytes: Uint8Array; readonly sha256: string }> {
  const backup = session.backup;
  if (!backup) throw new Error('this session has no backup key');
  const vault = await db.vault.get('main');
  const wrappers = await db.wrappers.toArray();
  const passphrase = wrappers.find(w => w.method === 'passphrase');
  const recovery = wrappers.find(w => w.method === 'recovery');
  if (!vault || !passphrase || !recovery) throw new Error('the vault is incomplete');
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const header: BackupHeader = {
    // no time in the plain header: when each month was sealed would say when the app was first used that month
    format: LOG_FORMAT, format_version: FORMAT_VERSION, schema_version: SCHEMA_VERSION, app_version: options.appVersion, exported_at: 0,
    vault_id: vault.vault_id, kid: vault.kid, generation: vault.generation, iv: toBase64url(iv),
    wrappers: { passphrase, recovery },
  };
  const head = headerBytes(header);
  const bytes = frame(head, await backup.sealBody(await gzip(jsonBytes({ changes: lines })), head, iv));
  return { bytes, sha256: await digestOf(bytes) };
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

/**
 * After the lock, in the write queue: writes the sealed month files in order, through tmp/, and
 * stops at the first that fails; puts the cursor past those written; moves aside any file the
 * cursor neither lists nor waits to remove. Returns whether all were written. The caller has checked
 * that no restore came between (the cursor row is still what was read at sealing).
 */
export async function writeMonths(core: RecordCore, files: SnapshotFiles, work: MonthWork, sealed: readonly SealedMonth[]): Promise<boolean> {
  let cursor = work.base;
  let all = true;
  for (const m of sealed) {
    if (m.kind === 'drop') {
      cursor = {
        ...cursor,
        ranges: cursor.ranges.filter(r => r.name !== m.replaces),
        rewrite: cursor.rewrite.filter(n => n !== m.replaces),
        retired: [...cursor.retired, m.replaces],
      };
      continue;
    }
    try {
      await files.write(TMP, m.bytes);
      await files.rename(TMP, `${LOG_DIR}/${m.range.name}`);
    } catch {
      all = false;
      break;
    }
    const old = m.replaces ?? m.range.name;
    cursor = m.kind === 'archive'
      ? { ...cursor, before: m.range.before, ranges: [...cursor.ranges, m.range] }
      : {
        ...cursor,
        ranges: cursor.ranges.map(r => (r.name === old ? m.range : r)),
        // made from the database, so either way the file holds no wiped words now
        rewrite: cursor.rewrite.filter(n => n !== old),
        retired: m.kind === 'rewrite' ? [...cursor.retired, old] : cursor.retired,
      };
  }
  if (cursor !== work.base) await core.db.device.put({ key: LOG_ARCHIVE, value: cursorValue(cursor) });
  await moveStrays(files, new Set([...cursor.ranges.map(r => r.name), ...cursor.retired, ...cursor.unremoved]), core.now()).catch(() => {});
  return all;
}

/**
 * Right after a latest naming their replacements is written, in the same write-queue turn: removes the
 * files rewrites replaced (they may hold wiped words, so they are not kept aside) and drops them from
 * the cursor. One that can't be removed goes to `unremoved`: tried again after the next latest, but
 * never a reason to write one, since no latest names it any more.
 */
export async function removeRetired(core: RecordCore, files: SnapshotFiles): Promise<void> {
  const c = parseCursor((await core.db.device.get(LOG_ARCHIVE))?.value);
  const due = [...c.retired, ...c.unremoved];
  if (due.length === 0) return;
  const there = await files.list(LOG_DIR).then(n => new Set(n), () => undefined);
  const left: string[] = [];
  for (const name of due) {
    if (there && !there.has(name)) continue;
    try {
      await files.remove(`${LOG_DIR}/${name}`);
    } catch {
      left.push(name);
    }
  }
  await core.db.device.put({ key: LOG_ARCHIVE, value: cursorValue({ ...c, retired: [], unremoved: left }) });
}

/**
 * At a restore, before the old cursor is replaced: removes the files it said may hold wiped words and
 * the new one doesn't keep. Moving them aside would keep the words; the safety copy holds the replaced
 * record's lines anyway.
 */
export async function removeWordy(files: SnapshotFiles, old: LogCursor, keep: ReadonlySet<string>): Promise<void> {
  for (const name of wordyFiles(old)) {
    if (!keep.has(name)) await files.remove(`${LOG_DIR}/${name}`).catch(() => {});
  }
}

/** Moves every month file not in `keep` to log-replaced/ (pruned after 7 days, like the safety copies); never deletes one. */
export async function moveStrays(files: SnapshotFiles, keep: ReadonlySet<string>, nowMs: number): Promise<void> {
  for (const name of await files.list(LOG_DIR)) {
    if (keep.has(name) || !NAME.test(name)) continue;
    await files.rename(`${LOG_DIR}/${name}`, `${REPLACED}/${String(nowMs).padStart(13, '0')}.${name}`);
  }
}
