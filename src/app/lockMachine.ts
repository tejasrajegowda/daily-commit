import type { RecordCore } from '../record/core.ts';
import type { SnapshotOutcome } from '../record/backup/snapshot.ts';
import { closeSession, openSession, type CloseDeps } from '../record/ops/session.ts';
import { vaultRows } from '../record/ops/vault.ts';
import type { Secret } from '../vault/cipher.ts';
import { offeredModes, unlockWithDevice, type DeviceAuth, type DeviceUnlock } from '../vault/devices.ts';
import type { DeviceMode, VaultPlugin } from '../vault/plugin.ts';
import { sessionCiphers, unlockWithSecret, type Unopened } from '../vault/vault.ts';

// The lock's order, as a small machine the screens follow. It never decides that the app was left:
// the phone's own code decides that and says so. The machine keeps the order: the content blanks
// at once, a snapshot is sealed while the keys are still there, the keys go, then the file is
// written. Leaving at any moment, even halfway through an unlock, ends locked.

export type LockState =
  /** `offered` is the device unlock choices; undefined while the phone hasn't answered yet */
  | { readonly kind: 'Locked'; readonly offered: readonly DeviceMode[] | undefined }
  | { readonly kind: 'Unlocking' }
  | { readonly kind: 'Open' }
  | { readonly kind: 'Locking' };

/** What the screen may show: black, the lock screen, or the record. */
export type Screen = 'blank' | 'lock' | 'record';

export function screenOf(state: LockState): Screen {
  if (state.kind === 'Open') return 'record';
  if (state.kind === 'Unlocking') return 'lock';
  if (state.kind === 'Locked' && state.offered !== undefined) return 'lock';
  return 'blank';
}

export type UnlockOutcome =
  | { readonly kind: 'Open' }
  | Unopened
  | Exclude<DeviceUnlock, { readonly kind: 'Unlocked' }>
  /** the app was left before the unlock finished; nothing stayed open */
  | { readonly kind: 'Left' }
  /** only a locked app can be unlocked */
  | { readonly kind: 'NotLocked' };

export interface LockDeps {
  readonly core: RecordCore;
  readonly plugin: VaultPlugin;
  /** where the snapshot at lock goes, and the phone's uptime clock that caps it */
  readonly close: CloseDeps;
}

export interface LockMachine {
  readonly state: LockState;
  /** the phone says the app came to the front: it is asked which device copies exist */
  resume(): Promise<void>;
  /** opens the record with the passphrase, the recovery code or a device copy */
  unlock(how: Secret | DeviceAuth): Promise<UnlockOutcome>;
  /** the phone says the app was left or the screen went off */
  leave(): Promise<SnapshotOutcome>;
  /** first run or a restore opened or locked the record outside the machine; the state follows it */
  follow(): Promise<void>;
  /** called with every new state; returns the way to stop listening */
  listen(listener: (state: LockState) => void): () => void;
}

export function lockMachine(deps: LockDeps): LockMachine {
  const { core, plugin } = deps;
  let state: LockState = core.session ? { kind: 'Open' } : { kind: 'Locked', offered: undefined };
  /** moved on by every leave, so an unlock started before it never opens anything */
  let turn = 0;
  let unlocking: Promise<UnlockOutcome> | undefined;
  let leaving: Promise<SnapshotOutcome> | undefined;
  const listeners = new Set<(state: LockState) => void>();

  const set = (next: LockState) => {
    state = next;
    for (const listener of listeners) listener(next);
  };

  /** Asks the phone which device copies exist, unless something else happened meanwhile. */
  async function askPhone(mine: number): Promise<void> {
    const offered = await offeredModes(plugin);
    if (mine === turn && state.kind === 'Locked') set({ kind: 'Locked', offered });
  }

  async function opening(how: Secret | DeviceAuth, mine: number): Promise<UnlockOutcome> {
    const rows = await vaultRows(core);
    if (!rows) throw new Error('nothing to unlock: first run has not finished');
    const opened = 'method' in how ? await unlockWithSecret(rows, how) : await unlockWithDevice(rows, plugin, how);
    if (mine !== turn) return { kind: 'Left' };          // the keys just made are never used
    if (opened.kind !== 'Unlocked') {
      set({ kind: 'Locked', offered: undefined });
      await askPhone(mine);
      return opened;
    }
    const { cipher, backup } = sessionCiphers(opened.keys);
    await openSession(core, cipher, backup);
    if (mine !== turn) return { kind: 'Left' };          // the leave waiting on this unlock closes what it opened
    set({ kind: 'Open' });
    return { kind: 'Open' };
  }

  async function unlock(how: Secret | DeviceAuth): Promise<UnlockOutcome> {
    if (state.kind !== 'Locked') return { kind: 'NotLocked' };
    const mine = turn;
    set({ kind: 'Unlocking' });
    const work = opening(how, mine);
    unlocking = work;
    try {
      return await work;
    } catch (e) {
      if (mine === turn) {
        await core.lock();                               // whatever opened goes, without a snapshot
        set({ kind: 'Locked', offered: undefined });
        await askPhone(mine);
      }
      throw e;
    } finally {
      if (unlocking === work) unlocking = undefined;
    }
  }

  function leave(): Promise<SnapshotOutcome> {
    if (leaving) return leaving;                         // leaving twice closes once
    if (state.kind === 'Locked') return Promise.resolve('unchanged');
    turn += 1;
    set({ kind: 'Locking' });                            // the content blanks at once
    const pending = unlocking;
    // With nothing being unlocked, the lock joins the write queue now, so a save asked for after
    // this moment is refused as Locked. An unlock under way finishes first and opens nothing.
    const closing = pending
      ? pending.then(() => undefined, () => undefined).then(() => closeSession(core, deps.close))
      : closeSession(core, deps.close);
    const done = closing.finally(() => {
      leaving = undefined;
      set({ kind: 'Locked', offered: undefined });       // black until the phone is asked again
    });
    leaving = done;
    return done;
  }

  async function resume(): Promise<void> {
    if (state.kind !== 'Locked') return;
    set({ kind: 'Locked', offered: undefined });
    await askPhone(turn);
  }

  async function follow(): Promise<void> {
    if (core.session) {
      set({ kind: 'Open' });
      return;
    }
    set({ kind: 'Locked', offered: undefined });
    await askPhone(turn);
  }

  return {
    get state() { return state; },
    resume,
    unlock,
    leave,
    follow,
    listen(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  };
}
