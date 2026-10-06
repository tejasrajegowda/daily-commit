import { MAGIC, readFrame } from '../record/backup/format.ts';
import { backupCipher } from '../vault/backupCipher.ts';
import { BackupError, type Secret } from '../vault/cipher.ts';
import type { AppDeps } from './context.ts';
import type { RestoreResult } from '../record/backup/restore.ts';
import { restoreBackup } from './restoreFlow.ts';

// One restore attempt, as the screen words it. The file and the secret are checked first; only
// then, if the record already holds something, does the person get asked before anything is
// replaced, and the question can say when the file is from a different record.

export type FileRead =
  | { readonly kind: 'File'; readonly bytes: Uint8Array; readonly madeAt: number }
  | { readonly kind: 'Newer' }
  /** not a Daily Commit backup at all (no backup mark): a photo, a document, an empty file */
  | { readonly kind: 'NotBackup' }
  /** a backup whose header can't be read */
  | { readonly kind: 'Unreadable' };

/** Reads the plain header only (no secret needed): when the backup was made. */
export function readBackupFile(bytes: Uint8Array): FileRead {
  if (bytes.length < MAGIC.length || !MAGIC.every((b, i) => bytes[i] === b)) return { kind: 'NotBackup' };
  try {
    return { kind: 'File', bytes, madeAt: readFrame(bytes).header.exported_at };
  } catch (e) {
    return e instanceof BackupError && e.reason === 'newer-app' ? { kind: 'Newer' } : { kind: 'Unreadable' };
  }
}

export type RestoreMessage = 'wrong' | 'newer' | 'damaged' | 'full' | 'not-backup' | 'other-record' | 'not-finished';

/** Why a "Replace everything" stopped after the keys were dropped for its safety copy. */
export type StopMessage = 'full' | 'not-saved' | 'not-finished';

export type RestoreStep =
  | { readonly kind: 'Restored' }
  /** the record already holds something: ask before replacing */
  | { readonly kind: 'Ask'; readonly otherRecord: boolean }
  /** nothing was locked: the person can try again from the same screen */
  | { readonly kind: 'Message'; readonly message: RestoreMessage }
  /** a replace that didn't happen, after the keys were dropped: the words, then the lock screen, never the question again */
  | { readonly kind: 'Stopped'; readonly message: StopMessage }
  /** the keys were already gone when the replace began: only the lock screen opens it now */
  | { readonly kind: 'Locked' };

/** One attempt. `replace` is true only after the person chose "Replace everything". */
export async function restoreWith(deps: AppDeps, bytes: Uint8Array, secret: Secret, replace: boolean): Promise<RestoreStep> {
  let result: RestoreResult | undefined;
  try {
    result = await restoreBackup({ core: deps.core, plugin: deps.device.plugin, machine: deps.machine }, {
      file: bytes, secret, backupCipher: backupCipher(),
      replace: replace ? { files: deps.device.files, appVersion: deps.appVersion } : undefined,
    });
  } catch {
    result = undefined;                                  // a failure with no name of its own still gets words
  } finally {
    deps.store.changed();
  }
  // a replace drops the keys before its safety copy, and they never come back on their own: whatever
  // went wrong after that, asking again can only find them gone, so the flow ends at the lock
  const dropped = replace && deps.core.session === undefined;
  if (!result) return dropped ? { kind: 'Stopped', message: 'not-finished' } : { kind: 'Message', message: 'not-finished' };
  switch (result.kind) {
    case 'Restored': return { kind: 'Restored' };
    case 'HasData': return { kind: 'Ask', otherRecord: result.otherVault };
    case 'QuotaFull': return dropped ? { kind: 'Stopped', message: 'full' } : { kind: 'Message', message: 'full' };
    case 'CopyFailed': return { kind: 'Stopped', message: 'not-saved' };
    case 'Locked': return { kind: 'Locked' };
    case 'Refused':
      if (result.reason === 'wrong-secret') return { kind: 'Message', message: (await isOtherRecord(deps, bytes).catch(() => false)) ? 'other-record' : 'wrong' };
      return { kind: 'Message', message: result.reason === 'newer-app' ? 'newer' : 'damaged' };
  }
}

/** Whether the file's plain vault_id differs from the record already on this phone, if any. Needs no secret. */
async function isOtherRecord(deps: AppDeps, bytes: Uint8Array): Promise<boolean> {
  const read = readBackupFile(bytes);
  if (read.kind !== 'File') return false;
  const existing = await deps.core.db.vault.get('main');
  return existing !== undefined && existing.vault_id !== readFrame(read.bytes).header.vault_id;
}
