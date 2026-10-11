import type { HandOffKind } from '../record/ops/device.ts';
import type { ScreenId } from './context.ts';

// What the app says, once, after a system screen it opened was cut short by Android ending the app
// (R-3). It says that Android did it, so it is clear that nothing the person did caused it.

export type HandOffNoteKind = HandOffKind | 'restore-first';

export const HAND_OFF_WORDS: Readonly<Record<HandOffNoteKind, { readonly title: string; readonly text: string; readonly again: string }>> = {
  export: { title: "The export didn't finish", text: 'Android closed Daily Commit while the save screen was open, so no copy was saved. Nothing else changed.', again: 'Export again' },
  restore: { title: "The restore didn't finish", text: 'Android closed Daily Commit while the file was being chosen, so nothing was restored. Your record is as it was.', again: 'Restore again' },
  fingerprint: { title: "Fingerprint wasn't set up", text: 'Android closed Daily Commit while the fingerprint screen was open, so nothing was changed.', again: 'Set it up again' },
  'restore-first': { title: "The restore didn't finish", text: 'Android closed Daily Commit while the file was being chosen, so nothing was restored.', again: 'Choose again' },
};

export const LEAVE_IT = 'Leave it';

/** Where "again" goes: Settings → Your data, Settings → Privacy, or the restore flow (a new phone). */
export function againTo(kind: HandOffNoteKind): { readonly screen: ScreenId; readonly variant: string } {
  if (kind === 'fingerprint') return { screen: 'settings', variant: 'privacy' };
  if (kind === 'restore-first') return { screen: 'restore', variant: '' };
  return { screen: 'settings', variant: 'data' };
}
