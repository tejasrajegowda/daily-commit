import type { BackupCipher, RowCipher } from '../../vault/cipher.ts';
import type { RecordCore, Session } from '../core.ts';
import type { SnapshotFiles } from '../files.ts';
import { MIGRATIONS, runMigrations, type PayloadMigration } from '../migrations.ts';
import type { BackupOptions } from '../backup/export.ts';
import { SNAPSHOT_CAP_MS, sealSnapshot, writeSnapshot, type SealedSnapshot, type SnapshotOutcome } from '../backup/snapshot.ts';
import { sweepTrash } from './words.ts';
import { finishRestore, runBaseline } from '../changes.ts';
import { LOG_ARCHIVE, monthWork, removeRetired, writeMonths, type MonthWork } from '../backup/monthLog.ts';

/**
 * Unlocks the record. Any change to the shape of locked values runs first, so the record opens in
 * the current shape; then a restore gets its line in the change log, rows with no line yet get their
 * baseline line, and anything whose 7 days in the trash are over is wiped. The app unlocks through this.
 */
export async function openSession(core: RecordCore, cipher: RowCipher, backup?: BackupCipher, migrations: readonly PayloadMigration[] = MIGRATIONS): Promise<void> {
  await runMigrations(core, cipher, migrations);
  await core.unlock(cipher, backup);
  await finishRestore(core);
  await runBaseline(core);
  await sweepTrash(core);
}

export interface CloseDeps extends BackupOptions {
  readonly files: SnapshotFiles;
  /** resolves after `ms` on the phone's uptime clock; never a JavaScript timer, which Android can hold back */
  readonly sleep: (ms: number) => Promise<void>;
}

/**
 * Locks the record, in this order: if anything changed, a snapshot is sealed while the keys are
 * still in memory, month files of the change log first, given at most 3 seconds (past that the
 * snapshot is abandoned, and the next lock tries again); every key is dropped; then, in one turn of
 * the write queue and only if no restore came between, the month files that were sealed are written
 * and the cursor moved past them, and the snapshot is written if every month file was. The screen
 * has blanked itself already. The app locks through this.
 */
export async function closeSession(core: RecordCore, deps: CloseDeps): Promise<SnapshotOutcome> {
  const months = monthWork();
  const held = await core.lock(session => sealInTime(core, session, deps, months));
  const sealed = [...months.sealed];                    // what finished in time; a seal still running after it goes nowhere
  if (held === undefined && sealed.length === 0) return 'unchanged';
  return core.serial(async (): Promise<SnapshotOutcome> => {
    const now = (await core.db.device.get(LOG_ARCHIVE))?.value;
    if ((now === undefined ? undefined : String(now)) !== months.expected) return 'unchanged';   // a restore replaced the record
    let allMonths = true;
    try {
      allMonths = await writeMonths(core, deps.files, months, sealed);
    } catch {
      allMonths = false;
    }
    if (held === undefined) return 'unchanged';
    if (typeof held === 'string') return held;
    if (!allMonths) return 'failed';                   // the snapshot leaves out lines only those files hold: keep the last one
    try {
      await writeSnapshot(deps.files, held);
    } catch {
      return 'failed';
    }
    // only now does no latest name the files rewrites replaced
    await removeRetired(core, deps.files).catch(() => {});
    return 'written';
  });
}

async function sealInTime(core: RecordCore, session: Session, deps: CloseDeps, months: MonthWork): Promise<SealedSnapshot | SnapshotOutcome> {
  let inTime = true;
  const work = sealSnapshot(core.db, backupUntil(session, () => inTime), deps.files, core.now(), deps, months);
  work.catch(() => {});      // once abandoned, its late failure is expected and goes nowhere
  try {
    return (await Promise.race([work, deps.sleep(SNAPSHOT_CAP_MS).then(() => 'abandoned' as const)])) ?? 'unchanged';
  } catch {
    return 'failed';
  } finally {
    inTime = false;
  }
}

/**
 * The session as the seal sees it: once the seal's time is over, its backup key refuses to start
 * any more work, so an abandoned seal can't go on using it after the lock. A WebCrypto call
 * already running can't be stopped; it ends, and its result goes nowhere.
 */
function backupUntil(session: Session, inTime: () => boolean): Session {
  const backup = session.backup;
  if (!backup) return session;
  const limited: BackupCipher = {
    sealBody: (body, headerBytes, iv) => (inTime() ? backup.sealBody(body, headerBytes, iv) : Promise.reject(new Error('the lock has passed'))),
    openBody: (...args) => backup.openBody(...args),
  };
  // reads the live session for everything else, so a change it records is still seen
  return Object.assign(Object.create(session) as Session, { backup: limited });
}
