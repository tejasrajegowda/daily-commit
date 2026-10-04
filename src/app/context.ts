import { createContext, useContext, useSyncExternalStore } from 'react';
import type { RecordCore } from '../record/core.ts';
import type { SnapshotFiles } from '../record/files.ts';
import type { Model } from '../record/model.ts';
import { dayRule } from '../record/ops/common.ts';
import { todayOf } from '../record/time.ts';
import { clockMinuteOf } from '../rules/dates.ts';
import type { LocalDate } from '../rules/types.ts';
import type { VaultPlugin } from '../vault/plugin.ts';
import type { Random } from '../vault/random.ts';
import type { MinuteClock } from './clock.ts';
import type { LockMachine } from './lockMachine.ts';
import type { LockActions } from './lockNotes.ts';
import type { RecordStore } from './store.ts';

// What the screens get from the app: the record, the lock, the store, the clock and the device,
// through React context. A feature imports app/ only through this file, and never vault/; the
// types a screen needs from below are re-exported here.

export type { DeviceMode } from '../vault/plugin.ts';
export type { Secret } from '../vault/cipher.ts';
export type { LockNote, UnlockHow } from './lockNotes.ts';
export { NOTE_WORDS } from './lockNotes.ts';
export { resultWords } from './resultWords.ts';
export { finishFirstRun, firstSettings, MIN_PASSPHRASE_CHARS, passphraseLongEnough, prepareVault, sameRecoveryCode, type Prepared } from './firstRunFlow.ts';
export { readBackupFile, restoreWith, type FileRead, type RestoreMessage, type RestoreStep } from './restoreSteps.ts';
export { DEFAULT_SHAPES, shapesOf } from './dayShapes.ts';
export { monthDue } from './reviewsDue.ts';

/** The phone, or the browser standing in for it. */
export interface DevicePort {
  readonly plugin: VaultPlugin;
  /** whether this device can hold device copies at all (false in a browser) */
  readonly deviceModes: boolean;
  /** the app's private files: snapshots and safety copies */
  readonly files: SnapshotFiles;
  /** calls back when the app is left or the screen goes off; returns the way to stop */
  onLeave(cb: () => void): () => void;
  /** calls back when the app comes to the front again */
  onResume(cb: () => void): () => void;
}

export interface AppDeps {
  readonly core: RecordCore;
  readonly machine: LockMachine;
  readonly lock: LockActions;
  readonly store: RecordStore;
  readonly clock: MinuteClock;
  readonly device: DevicePort;
  readonly random: Random;
  readonly appVersion: string;
}

export type ScreenId = 'today' | 'look' | 'habit' | 'week' | 'month' | 'diary' | 'notyet' | 'plan' | 'settings' | 'support'
  | 'restore' | 'secret';

export interface Nav {
  readonly screen: ScreenId;
  readonly variant: string;
}

export const AppContext = createContext<AppDeps | undefined>(undefined);
export const NavContext = createContext<{ readonly nav: Nav; go(screen: ScreenId, variant?: string): void } | undefined>(undefined);

export function useApp(): AppDeps {
  const deps = useContext(AppContext);
  if (!deps) throw new Error('a screen was drawn outside the app');
  return deps;
}

export function useNav(): { readonly nav: Nav; go(screen: ScreenId, variant?: string): void } {
  const nav = useContext(NavContext);
  if (!nav) throw new Error('a screen was drawn outside the app');
  return nav;
}

/** The open record's model, or undefined while locked; the screen draws again after every change. */
export function useModel(): Model | undefined {
  const { core, store } = useApp();
  useSyncExternalStore(store.subscribe, store.revision);
  return core.session?.model;
}

/** The record's now, to the minute; the screen draws again each minute. */
export function useMinute(): number {
  const { clock } = useApp();
  return useSyncExternalStore(clock.subscribe, clock.minute);
}

/** Minutes after midnight in the record's home timezone (the device's own while locked). */
export function useClockMinute(): number {
  const minute = useMinute();
  const tz = useModel()?.settings.tz ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  return clockMinuteOf(minute, tz);
}

/** Today, as the record decides it; undefined while locked. */
export function useToday(): LocalDate | undefined {
  const { core } = useApp();
  const minute = useMinute();
  useModel();
  const s = core.session;
  return s ? todayOf(Math.max(minute, core.now()), s.lastWriteMs, dayRule(s)) : undefined;
}

/** The lock screen's note, drawn again when it changes. */
export function useLockNote() {
  const { lock } = useApp();
  return useSyncExternalStore(lock.subscribe, lock.note);
}
