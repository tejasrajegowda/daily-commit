import type { BackupCipher, RowCipher } from '../../vault/cipher.ts';
import type { RecordCore, Session } from '../core.ts';
import type { SnapshotFiles } from '../files.ts';
import { MIGRATIONS, runMigrations, type PayloadMigration } from '../migrations.ts';
import type { BackupOptions } from '../backup/export.ts';
import { SNAPSHOT_CAP_MS, sealSnapshot, writeSnapshot, type SealedSnapshot, type SnapshotOutcome } from '../backup/snapshot.ts';
import { sweepTrash } from './words.ts';

/**
 * Unlocks the record. Any change to the shape of locked values runs first, so the record opens in
 * the current shape; then anything whose 7 days in the trash are over is wiped. The app unlocks
 * through this.
 */
export async function openSession(core: RecordCore, cipher: RowCipher, backup?: BackupCipher, migrations: readonly PayloadMigration[] = MIGRATIONS): Promise<void> {
  await runMigrations(core, cipher, migrations);
  await core.unlock(cipher, backup);
  await sweepTrash(core);
}

export interface CloseDeps extends BackupOptions {
  readonly files: SnapshotFiles;
  /** resolves after `ms` on the phone's uptime clock; never a JavaScript timer, which Android can hold back */
  readonly sleep: (ms: number) => Promise<void>;
}

/**
 * Locks the record, in this order: if anything changed, a snapshot is sealed while the keys are
 * still in memory, given at most 3 seconds (past that it is abandoned, and the next lock tries
 * again); every key is dropped; then the file is written. The screen has blanked itself already.
 * The app locks through this.
 */
export async function closeSession(core: RecordCore, deps: CloseDeps): Promise<SnapshotOutcome> {
  const held = await core.lock(session => sealInTime(core, session, deps));
  if (held === undefined) return 'unchanged';
  if (typeof held === 'string') return held;
  try {
    await writeSnapshot(deps.files, held);
    return 'written';
  } catch {
    return 'failed';
  }
}

async function sealInTime(core: RecordCore, session: Session, deps: CloseDeps): Promise<SealedSnapshot | SnapshotOutcome> {
  let inTime = true;
  const work = sealSnapshot(core.db, backupUntil(session, () => inTime), deps.files, core.now(), deps);
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
