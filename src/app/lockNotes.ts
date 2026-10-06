import type { Secret } from '../vault/cipher.ts';
import type { DeviceAuth } from '../vault/devices.ts';
import type { DeviceMode } from '../vault/plugin.ts';
import type { LockMachine, UnlockOutcome } from './lockMachine.ts';

// What the lock screen says after an unlock that didn't open. Every note says what happened and
// what opens it now, and never how many tries are left.

export type LockNote =
  /** the passphrase or recovery code didn't open it */
  | 'wrong-secret'
  /** a wrong own code, with tries still left */
  | 'wrong-code'
  /** the code's copy went after wrong codes: the code and fingerprint are off */
  | 'code-off'
  /** the fingerprint's copy is gone; the code still opens it */
  | 'new-fingerprint'
  /** a device copy is gone for another reason; the passphrase opens it */
  | 'mode-off'
  | 'newer-app'
  | 'damaged';

export type UnlockWay = 'passphrase' | 'recovery' | DeviceMode;

/** How the person tried to open it: what was typed, or which device copy. */
export type UnlockHow = Secret | DeviceAuth;

export const wayOf = (how: UnlockHow): UnlockWay => ('method' in how ? how.method : how.mode);

/**
 * What to tell the person after an unlock that didn't open; undefined when nothing needs saying.
 * `before` is the outcome of the try before, so the code going after wrong codes is told apart.
 */
export function noteFor(way: UnlockWay, outcome: UnlockOutcome, before?: UnlockOutcome): LockNote | undefined {
  switch (outcome.kind) {
    case 'WrongSecret': return 'wrong-secret';
    case 'WrongCode': return 'wrong-code';
    case 'Refused': return outcome.reason === 'newer-app' ? 'newer-app' : 'damaged';
    case 'CopyGone':
      if (way === 'own-code' && before?.kind === 'WrongCode') return 'code-off';
      if (way === 'fingerprint' && outcome.offered.includes('own-code')) return 'new-fingerprint';
      return 'mode-off';
    default: return undefined;
  }
}

export const NOTE_WORDS: Readonly<Record<LockNote, { readonly title?: string; readonly text: string }>> = {
  'wrong-secret': { text: "That didn't open it. Check it and try again." },
  'wrong-code': { text: "That code didn't open it." },
  'code-off': { text: 'Five wrong codes, so the code and fingerprint are switched off. Your passphrase opens it. You can set a new code afterwards, in Settings → Privacy.' },
  'new-fingerprint': { text: 'A new fingerprint was added to this phone, so fingerprint unlock is off until you type your code.' },
  'mode-off': { text: 'That way of opening is switched off now, so your passphrase opens it. You can set it up again in Settings → Privacy.' },
  'newer-app': { title: 'Made by a newer version', text: 'This record was saved by a newer version of Daily Commit. Update the app to open it.' },
  'damaged': { title: "This record can't be opened", text: 'Its lock is damaged. A backup may still open it.' },
};

/** The lock screen's actions: unlock, and the note it leaves. */
export interface LockActions {
  unlock(how: UnlockHow): Promise<UnlockOutcome>;
  readonly note: () => LockNote | undefined;
  subscribe(listener: () => void): () => void;
  /** the lock screen was left behind (the record opened, or the app was left) */
  clear(): void;
}

export function lockActions(machine: LockMachine): LockActions {
  let note: LockNote | undefined;
  let before: UnlockOutcome | undefined;
  let turn = 0;                                          // a clear starts a new turn; an answer from an older one is dropped
  const listeners = new Set<() => void>();
  const set = (next: LockNote | undefined) => {
    note = next;
    for (const listener of [...listeners]) {
      try {
        listener();
      } catch {
        // a screen that fails to draw never stops the lock
      }
    }
  };
  return {
    async unlock(how) {
      set(undefined);
      const mine = turn;
      const outcome = await machine.unlock(how);
      if (mine !== turn) return outcome;
      set(noteFor(wayOf(how), outcome, before));
      before = outcome;
      return outcome;
    },
    note: () => note,
    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    clear() {
      turn += 1;
      before = undefined;
      if (note !== undefined) set(undefined);
    },
  };
}
