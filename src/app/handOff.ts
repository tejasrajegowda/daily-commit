import { readHandOff, writeHandOff, type HandOffKind } from '../record/ops/device.ts';
import type { AppDeps } from './context.ts';

// A system screen the app opens itself ("save as", the file picker, the fingerprint set-up) is a
// hand-off: leaving for it doesn't lock. If Android ends the app while it is open, the app comes
// back fresh and locked, and the result is dropped (R-3). Only the kind is remembered, in this
// device's own plain table, so the next unlock can say what didn't finish; never what was in it.

/** Runs `open` with the hand-off marked; the mark is written before the screen opens and goes when it returns. */
export async function duringHandOff<T>(deps: AppDeps, kind: HandOffKind, open: () => Promise<T>): Promise<T> {
  if (!deps.device.deviceModes) return open();          // a browser is never ended this way
  await writeHandOff(deps.core.db, kind).catch(() => {});
  try {
    return await open();
  } finally {
    await writeHandOff(deps.core.db, undefined).catch(() => {});
  }
}

/** What didn't finish the last time, said once: the mark goes as it is read. */
export async function takeHandOff(deps: AppDeps): Promise<HandOffKind | undefined> {
  const kind = await readHandOff(deps.core.db).catch(() => undefined);
  if (kind !== undefined) await writeHandOff(deps.core.db, undefined).catch(() => {});
  return kind;
}
