import type { Session } from '../core.ts';
import type { RecordDb } from '../db.ts';
import type { SnapshotFiles } from '../files.ts';
import { appDay } from '../time.ts';
import { sealBackup, type BackupOptions } from './export.ts';
import { readFrame } from './format.ts';

// The automatic copy. Each time the app locks after a change, one whole backup goes to
// backup/latest.dcbak, the only file Android's own backup carries. The first snapshot of a new
// app day first keeps the previous one in backup/older/, which holds the last three days.

export const LATEST = 'backup/latest.dcbak';
export const OLDER = 'backup/older';
export const KEEP_OLDER = 3;
export const SNAPSHOT_CAP_MS = 3000;
const TMP = 'tmp/snapshot.dcbak';
const TMP_OLDER = 'tmp/older.dcbak';
const OLDER_NAME = /^\d{4}-\d{2}-\d{2}\.dcbak$/;

/** What the snapshot at lock did. */
export type SnapshotOutcome = 'written' | 'unchanged' | 'abandoned' | 'failed';

/** A snapshot sealed while the keys were in memory, waiting to be written once they are gone. */
export interface SealedSnapshot {
  readonly bytes: Uint8Array;
  /** the previous latest and its app day, when that day is over and it is kept in older/ */
  readonly retire?: { readonly bytes: Uint8Array; readonly day: string };
}

/** When a snapshot file was made, or undefined if there is none or it is damaged. */
function madeAt(file: Uint8Array | undefined): number | undefined {
  if (!file) return undefined;
  try {
    return readFrame(file).header.exported_at;
  } catch {
    return undefined;
  }
}

/**
 * Seals a snapshot if anything changed since the last one, or returns undefined. Runs inside the
 * lock's turn in the write queue, while the keys are still in memory.
 */
export async function sealSnapshot(db: RecordDb, session: Session, files: SnapshotFiles, now: number, options: BackupOptions): Promise<SealedSnapshot | undefined> {
  const previous = await files.read(LATEST);
  const previousAt = madeAt(previous);
  if (previousAt !== undefined && (session.lastWriteMs ?? 0) <= previousAt) return undefined;
  const { bytes, header } = await sealBackup(db, session, now, options);
  const rule = session.model.settings;
  const previousDay = previousAt === undefined ? undefined : appDay(previousAt, rule);
  return previous && previousDay !== undefined && previousDay < appDay(header.exported_at, rule)
    ? { bytes, retire: { bytes: previous, day: previousDay } }
    : { bytes };
}

/**
 * Writes a sealed snapshot. Every file is written to tmp/ and renamed into place, so latest.dcbak
 * is never half-written and never missing, even for a moment.
 */
export async function writeSnapshot(files: SnapshotFiles, sealed: SealedSnapshot): Promise<void> {
  if (sealed.retire) {
    await files.write(TMP_OLDER, sealed.retire.bytes);
    await files.rename(TMP_OLDER, `${OLDER}/${sealed.retire.day}.dcbak`);
  }
  await files.write(TMP, sealed.bytes);
  await files.rename(TMP, LATEST);
  const older = (await files.list(OLDER)).filter(name => OLDER_NAME.test(name)).sort();
  for (const name of older.slice(0, Math.max(0, older.length - KEEP_OLDER))) await files.remove(`${OLDER}/${name}`);
}
