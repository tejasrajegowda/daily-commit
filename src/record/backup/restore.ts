import { BackupError, CipherError, type BackupCipher, type BackupFailure, type Envelope, type EnvelopeContext, type Secret } from '../../vault/cipher.ts';
import { CHANGE_TAG, TABLE_TAGS, type LockedTable } from '../../vault/tags.ts';
import { isQuotaFull, type RecordCore } from '../core.ts';
import { jsonBytes } from '../bytes.ts';
import type { RecordDb, Schema } from '../db.ts';
import { upgradeTables } from '../upgrade.ts';
import type { SnapshotFiles } from '../files.ts';
import { plainOf, rowId } from '../payload.ts';
import { LOG_BASELINE, PENDING_RESTORE } from '../changes.ts';
import type { ChangeRow, VaultRow } from '../rows.ts';
import { BODY_TABLES, gunzip, gzip, parseBody, readRaw, type StoredRows } from './body.ts';
import { SAFETY, keepCopy } from './copies.ts';
import { sealBackup, type SealedBackup } from './export.ts';
import { LOG_FORMAT, readFrame, type BackupHeader } from './format.ts';
import { LOG_ARCHIVE, clearMonths, parseMonth, readMonths } from './monthLog.ts';
import { LATEST, writeSnapshot } from './snapshot.ts';

// Restore, in two phases. First everything is checked, outside any transaction: the file opens
// with the secret, its header agrees with its vault, and every locked value inside opens under the
// file's own keys. Then one transaction clears the record and writes the file's rows exactly as
// they are stored.

export interface CheckedBackup {
  readonly header: BackupHeader;
  /** the file's rows, its change log joined by the lines of every month file that checked out */
  readonly tables: StoredRows;
  /** the month files read with it: how many were joined, how many were left out (counts only) */
  readonly months: { readonly read: number; readonly skipped: number };
}

const LOCKED_TABLES: readonly LockedTable[] = ['settings', 'habits', 'observations', 'days', 'entries', 'notyet', 'cues', 'reviews'];

const damaged = () => new BackupError('damaged');

const isEnvelope = (v: unknown): v is Envelope =>
  typeof v === 'object' && v !== null && typeof (v as Envelope).v === 'number' && typeof (v as Envelope).k === 'string'
  && typeof (v as Envelope).iv === 'string' && typeof (v as Envelope).ct === 'string';

type Sealed = { readonly ctx: EnvelopeContext; readonly env: Envelope };

/** A change-log line's shape: its id, exactly one sealed slot, plain ref and time of the right kind. */
function lineValue(row: Readonly<Record<string, unknown>>): Sealed {
  const slots = (['r', 'w'] as const).filter(slot => row[slot] !== undefined);
  if (typeof row.id !== 'string' || row.id === '' || slots.length !== 1) throw damaged();
  if ((row.ref !== undefined && typeof row.ref !== 'string') || (row.at !== undefined && typeof row.at !== 'number')) throw damaged();
  const slot = slots[0] ?? 'r';
  const env = row[slot];
  if (!isEnvelope(env)) throw damaged();
  return { ctx: { table: CHANGE_TAG, id: row.id, slot }, env };
}

/**
 * Phase 1: opens and checks a backup, writing nothing. Rejects with a BackupError. Month files
 * (the phone's own copy keeps the log's finished months beside it) are joined when they check out;
 * one that doesn't is left out and counted, and never stops the restore.
 */
export async function checkBackup(file: Uint8Array, secret: Secret, backupCipher: BackupCipher, monthFiles: readonly Uint8Array[] = []): Promise<CheckedBackup> {
  const { header, headerBytes, iv, ct } = readFrame(file);
  const opened = await backupCipher.openBody(headerBytes, iv, ct, header.wrappers, secret);
  const tables = parseBody(await gunzip(opened.body), header.schema_version);
  const vault = tables.vault[0] as VaultRow | undefined;
  if (tables.vault.length !== 1 || vault?.key !== 'main' || vault.vault_id !== header.vault_id || vault.kid !== header.kid
    || vault.generation !== header.generation || header.wrappers.passphrase.kid !== vault.kid || header.wrappers.recovery.kid !== vault.kid) throw damaged();
  // every row's shape first, so a refusal here leaves no test-open running
  const values: { readonly ctx: EnvelopeContext; readonly env: Envelope }[] = [];
  for (const table of LOCKED_TABLES) {
    for (const row of tables[table] as readonly Record<string, unknown>[]) {
      const slots = (['r', 'w'] as const).filter(slot => row[slot] !== undefined);
      if (row.deleted_at !== undefined && slots.length > 0) throw damaged();     // a tombstone never carries a locked value
      let id: string;
      try {
        id = rowId(table, plainOf(table, row));
      } catch {
        throw damaged();
      }
      for (const slot of slots) {
        const env = row[slot];
        if (!isEnvelope(env)) throw damaged();
        values.push({ ctx: { table: TABLE_TAGS[table], id, slot }, env });
      }
    }
  }
  for (const row of tables.changes as readonly Record<string, unknown>[]) values.push(lineValue(row));
  try {
    // W and R are opened even when the file holds no locked value, so a file whose keys can't be
    // opened as unlock opens them is refused here, before anything is written
    await opened.openKeys(vault);
    await Promise.all(values.map(({ ctx, env }) => opened.testOpen(vault, ctx, env)));
  } catch (e) {
    throw new BackupError(e instanceof CipherError && e.failure === 'newer-app' ? 'newer-app' : 'damaged');
  }
  // the month files: each must name this vault and open with its key; the file's own lines win
  const lines = [...(tables.changes as readonly ChangeRow[])];
  const seen = new Set(lines.map(l => l.id));
  let read = 0, skipped = 0;
  for (const month of monthFiles) {
    try {
      const f = readFrame(month, LOG_FORMAT);
      if (f.header.vault_id !== header.vault_id || f.header.kid !== header.kid || f.header.generation !== header.generation) throw damaged();
      const body = parseMonth(await gunzip(await opened.openSibling(f.headerBytes, f.iv, f.ct)));
      const checked = body.map(row => ({ row, sealed: lineValue(row as unknown as Record<string, unknown>) }));
      await Promise.all(checked.map(({ sealed }) => opened.testOpen(vault, sealed.ctx, sealed.env)));
      for (const { row } of checked) {
        if (seen.has(row.id)) continue;
        seen.add(row.id);
        lines.push(row);
      }
      read++;
    } catch {
      skipped++;
    }
  }
  return { header, tables: monthFiles.length === 0 ? tables : { ...tables, changes: lines }, months: { read, skipped } };
}

export interface RestoreInput {
  readonly file: Uint8Array;
  readonly secret: Secret;
  /** opens the file; it needs no backup key, so it works on a phone never set up */
  readonly backupCipher: BackupCipher;
  /** given when "replace everything" was chosen: the safety copy is kept through these files first */
  readonly replace?: {
    readonly files: SnapshotFiles;
    readonly appVersion: string;
    /**
     * the record here refused to open, so it can't be sealed: while it is locked it is replaced
     * without being opened, and its rows as stored, with the phone's last snapshot of it, are the
     * safety copy
     */
    readonly unopened?: boolean;
  };
  /** the schema versions to bring an older file's rows up to; the app leaves it out */
  readonly schemas?: readonly Schema[];
  /**
   * The app's private files, for the change log's month files: with `months`, the file is the
   * phone's own copy and every month file beside it is read and joined. Either way, after a restore
   * the month files are removed: they belong to the record that was replaced.
   */
  readonly log?: { readonly files: SnapshotFiles; readonly months: boolean };
}

export type RestoreResult =
  | { readonly kind: 'Restored' }
  /** wrong passphrase · needs a newer app · file damaged */
  | { readonly kind: 'Refused'; readonly reason: BackupFailure }
  /** the record has data and "replace everything" wasn't chosen; the question says if the file is another vault's */
  | { readonly kind: 'HasData'; readonly otherVault: boolean }
  | { readonly kind: 'QuotaFull' }
  /** the safety copy before a replace couldn't be written, for a reason other than a full phone; nothing was replaced */
  | { readonly kind: 'CopyFailed' }
  | { readonly kind: 'Locked' };

/**
 * Restores a backup. Into an empty record any valid file goes; into one with data only when
 * "replace everything" was chosen, after a safety copy. The record ends locked either way. A
 * record that refused to open is replaced only when the caller says so, and only while it is locked.
 */
export async function restore(core: RecordCore, input: RestoreInput): Promise<RestoreResult> {
  let checked: CheckedBackup;
  try {
    const months = input.log?.months ? await readMonths(input.log.files).catch(() => []) : [];
    checked = await checkBackup(input.file, input.secret, input.backupCipher, months);
  } catch (e) {
    if (e instanceof BackupError) return { kind: 'Refused', reason: e.reason };
    throw e;
  }
  const replace = input.replace;
  const existing = await core.db.vault.get('main');
  if (existing && !replace) return { kind: 'HasData', otherVault: existing.vault_id !== checked.header.vault_id };
  if (existing && replace?.unopened && !core.session) {
    // nothing is open and nothing is dropped: a failed copy or replace leaves the record exactly as it was.
    // A record that won't open may still hold good rows, so they are always kept as stored, and the
    // phone's last snapshot of it beside them when there is one.
    try {
      const at = core.now();
      await keepCopy(replace.files, SAFETY, at, RAW_EXT, await rawRecordCopy(core.db));
      const last = await replace.files.read(LATEST);
      if (last) await keepCopy(replace.files, SAFETY, at, 'dcbak', last);
    } catch (e) {
      return isQuotaFull(e) ? { kind: 'QuotaFull' } : { kind: 'CopyFailed' };
    }
  } else if (existing && replace) {
    // sealed while the record is still open; then the keys drop, before the copy is written, and
    // stay gone whatever follows. A failed seal or copy replaces nothing. `Locked` means the keys
    // were already gone when this attempt began, so there was nothing to seal.
    let safety: SealedBackup | undefined;
    try {
      safety = await core.lock(session => sealBackup(core.db, session, core.now(), { appVersion: replace.appVersion }));
    } catch (e) {
      return isQuotaFull(e) ? { kind: 'QuotaFull' } : { kind: 'CopyFailed' };
    }
    if (!safety) return { kind: 'Locked' };
    try {
      await keepCopy(replace.files, SAFETY, core.now(), 'dcbak', safety.bytes);
    } catch (e) {
      return isQuotaFull(e) ? { kind: 'QuotaFull' } : { kind: 'CopyFailed' };
    }
  }
  const months: Readonly<Record<string, number>> = input.log?.months ? { months: checked.months.read, months_skipped: checked.months.skipped } : {};
  const result = await core.serial(() => replaceAll(core, checked.header, upgradeTables(checked.tables, checked.header.schema_version, input.schemas), replace !== undefined, months));
  if (result.kind === 'Restored' && input.log) await clearMonths(input.log.files).catch(() => {});
  if (result.kind === 'Restored' && replace) await becomeLatest(replace.files, input.file);
  return result;
}

/** The extension of a raw copy, so it is never taken for a backup. */
export const RAW_EXT = 'dcraw';
/** Names what a raw copy is, in its own first field. */
export const RAW_FORMAT = 'daily-commit raw record copy';

/**
 * A record exactly as stored, read without any key: every body table and the wrappers, as gzip of
 * UTF-8 JSON under a small header. Locked values stay locked, so nothing in it becomes readable.
 */
export async function rawRecordCopy(db: RecordDb): Promise<Uint8Array> {
  const raw = await readRaw(db);
  return gzip(jsonBytes({ format: RAW_FORMAT, version: 1, schema_version: db.verno, tables: raw.tables, wrappers: raw.wrappers }));
}

/**
 * After "replace everything", the file just restored becomes the latest snapshot: it is a sealed
 * backup of exactly the rows now stored, and the old latest holds the data that was replaced. If it
 * can't be written, the old latest is removed, so the next lock writes a fresh one.
 */
async function becomeLatest(files: SnapshotFiles, file: Uint8Array): Promise<void> {
  try {
    await writeSnapshot(files, { bytes: file });
  } catch {
    await files.remove(LATEST).catch(() => {});
  }
}

/** Phase 2: one transaction that clears and adds. A failed add is never caught, so it undoes everything. */
async function replaceAll(core: RecordCore, header: BackupHeader, tables: StoredRows, replacing: boolean, months: Readonly<Record<string, number>>): Promise<RestoreResult> {
  const { db } = core;
  const deviceId = core.newId();
  const reset = `reset:${core.newId()}`;
  const cleared = [...BODY_TABLES, 'wrappers', 'migrations'] as const;
  try {
    return await db.transaction('rw', [...cleared, 'device'].map(t => db.table(t)), async (): Promise<RestoreResult> => {
      const now = await db.vault.get('main');
      if (now && !replacing) return { kind: 'HasData', otherVault: now.vault_id !== header.vault_id };
      for (const t of cleared) await db.table(t).clear();
      for (const t of BODY_TABLES) await db.table(t).bulkAdd([...tables[t]]);
      await db.wrappers.bulkAdd([header.wrappers.passphrase, header.wrappers.recovery]);
      if (!(await db.device.get('device_id'))) await db.device.add({ key: 'device_id', value: deviceId });
      // restore runs locked, with no key to seal a line with: a plain marker waits for the next unlock,
      // and the baseline runs again for any row the file brought without a line (design §2.3)
      const rows = BODY_TABLES.reduce((n, t) => n + tables[t].length, 0);
      await db.device.put({ key: PENDING_RESTORE, value: JSON.stringify({ schema_version: header.schema_version, rows, ...months }) });
      await db.device.put({ key: LOG_BASELINE, value: '' });
      // the month files on this phone are the replaced record's: the cursor starts over, and a lock
      // still holding an old month file can no longer move it
      await db.device.put({ key: LOG_ARCHIVE, value: reset });
      return { kind: 'Restored' };
    });
  } catch (e) {
    if (isQuotaFull(e)) return { kind: 'QuotaFull' };
    throw e;
  }
}
