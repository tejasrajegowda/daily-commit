import { openRecord, type RecordCore } from '../record/core.ts';
import type { StorageDeps } from '../record/db.ts';
import { writePersisted } from '../record/ops/device.ts';
import { openStorage } from '../record/upgrade.ts';
import { devicePort } from '../device/index.ts';
import { systemRandom, type Random } from '../vault/random.ts';
import { minuteClock } from './clock.ts';
import type { AppDeps, DevicePort } from './context.ts';
import { lockMachine } from './lockMachine.ts';
import { lockActions } from './lockNotes.ts';
import { PHONE_ANSWER_MS } from './phoneAnswer.ts';
import { recordStore } from './store.ts';

// Builds what the app runs on: the phone's port inside the Android app, the browser's elsewhere.
// Storage is opened through openStorage, so a record saved by a newer app is refused before
// anything opens it, and a raw copy is kept before an upgrade. The screen harness assembles the
// same pieces around its invented record.

export const APP_VERSION = '0.1.0';

/** Where a start stopped: reaching the phone, opening storage, or anything after. */
export type StartStep = 'device' | 'storage' | 'app';

export type Composed =
  | { readonly kind: 'Ready'; readonly deps: AppDeps }
  | { readonly kind: 'AppTooOld' }
  /** A start that threw: where, and the error's type only (never its message, which could carry anything). */
  | { readonly kind: 'StartFailed'; readonly step: StartStep; readonly error: string };

/** The error's type for the start-failed screen: its name when it is a plain word, else "Error". */
export function errorType(e: unknown): string {
  const name = e instanceof Error ? e.name : '';
  return /^[A-Za-z]{1,40}$/.test(name) ? name : 'Error';
}

/**
 * The first paint. A start that failed says so, with where it stopped; it is never shown as an app that is too
 * old, whose advice (install the newer version) would be wrong for it (D-37).
 */
export function openingView(made: Composed | undefined): 'ready' | 'too-old' | 'failed' {
  if (made?.kind === 'Ready') return 'ready';
  return made?.kind === 'AppTooOld' ? 'too-old' : 'failed';
}

/**
 * The pieces around a record and a device. On the phone the snapshot's 3-second cap runs on the
 * Shell's uptime clock, which Android can't hold back; in a browser, on a JavaScript timer.
 */
export function assemble(core: RecordCore, device: DevicePort, random: Random = systemRandom, appVersion = APP_VERSION, answerMs = PHONE_ANSWER_MS): AppDeps {
  const sleep = device.sleep ?? ((ms: number) => new Promise<void>(done => setTimeout(done, ms)));
  const machine = lockMachine({ core, plugin: device.plugin, close: { files: device.files, sleep, appVersion }, answerMs });
  return { core, machine, lock: lockActions(machine, device.timing), store: recordStore(core), clock: minuteClock(core.now), device, random, appVersion };
}

/** Opens storage for this device, asks it to keep the storage safe, and assembles the app. */
export async function composeWith(device: DevicePort, storage: StorageDeps, now: () => number = Date.now): Promise<Composed> {
  const opened = await openStorage(storage, device.files, now);
  if (opened.kind === 'AppTooOld') return opened;
  const kept = await device.persist?.().catch(() => undefined);
  if (kept !== undefined) await writePersisted(opened.db, kept).catch(() => {});
  return { kind: 'Ready', deps: assemble(openRecord({ db: opened.db, now }), device) };
}

/** A start that never throws: a failure comes back as StartFailed, saying at which step. */
export async function startWith(port: () => Promise<DevicePort>, storage: StorageDeps, now: () => number = Date.now): Promise<Composed> {
  let step: StartStep = 'device';
  try {
    const device = await port();
    step = 'storage';
    return await composeWith(device, storage, now);
  } catch (e) {
    return { kind: 'StartFailed', step, error: errorType(e) };
  }
}

export function compose(): Promise<Composed> {
  return startWith(devicePort, { name: 'daily-commit', indexedDB, IDBKeyRange });
}
