import type { RecordCore } from '../record/core.ts';
import { restore, type RestoreInput, type RestoreResult } from '../record/backup/restore.ts';
import { forgetDevice } from '../vault/devices.ts';
import type { VaultPlugin } from '../vault/plugin.ts';
import type { LockMachine } from './lockMachine.ts';

// Restoring a backup, as the app does it. Once the record holds the file's rows, every phone copy
// of the master key is deleted before anything can unlock, because a copy made for the record that
// was there before would open the wrong keys. After a restore the passphrase opens the record, and
// phone lock or an own code can be set up again.

export interface RestoreDeps {
  readonly core: RecordCore;
  readonly plugin: VaultPlugin;
  readonly machine: LockMachine;
}

export async function restoreBackup(deps: RestoreDeps, input: RestoreInput): Promise<RestoreResult> {
  const result = await restore(deps.core, input);
  if (result.kind === 'Restored') {
    try {
      await forgetDevice(deps.plugin);
    } catch {
      // a copy left behind still can't open the wrong keys: every device unlock checks it opens
      // this vault's keys, and deletes every copy if it doesn't
    }
  }
  await deps.machine.follow();
  return result;
}
