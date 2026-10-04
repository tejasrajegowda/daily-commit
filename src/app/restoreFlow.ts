import type { RecordCore } from '../record/core.ts';
import { restore, type RestoreInput, type RestoreResult } from '../record/backup/restore.ts';
import { forgetDevice } from '../vault/devices.ts';
import type { VaultPlugin } from '../vault/plugin.ts';
import type { LockMachine } from './lockMachine.ts';

// Restoring a backup, as the app does it. Once the record holds the file's rows, every phone copy
// of the master key is deleted before anything can unlock: a copy made for the record that was
// there before would open the wrong keys, and after a restore only the passphrase opens. Phone
// lock or an own code can then be set up again.

export interface RestoreDeps {
  readonly core: RecordCore;
  readonly plugin: VaultPlugin;
  readonly machine: LockMachine;
}

export async function restoreBackup(deps: RestoreDeps, input: RestoreInput): Promise<RestoreResult> {
  try {
    const result = await restore(deps.core, input);
    if (result.kind === 'Restored') await forgetEveryCopy(deps.plugin);
    return result;
  } finally {
    await deps.machine.follow();                         // even a restore that failed halfway leaves the lock screen true
  }
}

/** Deletes every phone copy, asking the phone twice before giving up. */
async function forgetEveryCopy(plugin: VaultPlugin): Promise<void> {
  try {
    await forgetDevice(plugin);
  } catch {
    try {
      await forgetDevice(plugin);
    } catch {
      // A copy still left is the phone's own failure, which the native plugin reports (U5). A copy
      // from another vault can't open this one: every device unlock checks it opens this vault's
      // keys, and deletes every copy if it doesn't. A copy of this same vault can still open it.
    }
  }
}
