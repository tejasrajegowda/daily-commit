import { exportBackup } from '../record/backup/export.ts';
import { LATEST } from '../record/backup/snapshot.ts';
import { readDisplay, writeDisplay, type Display } from '../record/ops/device.ts';
import type { AppDeps } from './context.ts';
import { duringHandOff } from './handOff.ts';
import { readBackupFile } from './restoreSteps.ts';

// What Settings → Your data and Display read and do: when the last automatic copy was made, the
// manual export handed to the device as a file to save, the space used, and this device's display.

/** When the newest automatic copy was made, from its plain header; undefined if there is none yet. */
export async function lastCopyAt(deps: AppDeps): Promise<number | undefined> {
  const bytes = await deps.device.files.read(LATEST).catch(() => undefined);
  const read = bytes ? readBackupFile(bytes) : undefined;
  return read?.kind === 'File' ? read.madeAt : undefined;
}

export type ExportOutcome = 'Saved' | 'Cancelled' | 'NoSave' | 'Failed';

/** Seals a backup and hands it to the device's "save as"; nothing is kept by the app. */
export async function exportCopy(deps: AppDeps): Promise<ExportOutcome> {
  const save = deps.device.saveFile;
  if (!save) return 'NoSave';
  const made = await exportBackup(deps.core, { appVersion: deps.appVersion });
  if (made.kind !== 'Saved') return 'Failed';
  return (await duringHandOff(deps, 'export', () => save(made.value.name, made.value.bytes)).catch(() => false)) ? 'Saved' : 'Cancelled';
}

export const spaceUsed = (deps: AppDeps): Promise<number | undefined> =>
  deps.device.spaceUsed?.().catch(() => undefined) ?? Promise.resolve(undefined);

export const displayOf = (deps: AppDeps): Promise<Display> => readDisplay(deps.core.db);

export const saveDisplay = (deps: AppDeps, display: Display): Promise<void> => writeDisplay(deps.core.db, display);
