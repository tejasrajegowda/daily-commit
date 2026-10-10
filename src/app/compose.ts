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
import { recordStore } from './store.ts';

// Builds what the app runs on: the phone's port inside the Android app, the browser's elsewhere.
// Storage is opened through openStorage, so a record saved by a newer app is refused before
// anything opens it, and a raw copy is kept before an upgrade. The screen harness assembles the
// same pieces around its invented record.

export const APP_VERSION = '0.1.0';

export type Composed = { readonly kind: 'Ready'; readonly deps: AppDeps } | { readonly kind: 'AppTooOld' };

/**
 * The pieces around a record and a device. On the phone the snapshot's 3-second cap runs on the
 * Shell's uptime clock, which Android can't hold back; in a browser, on a JavaScript timer.
 */
export function assemble(core: RecordCore, device: DevicePort, random: Random = systemRandom, appVersion = APP_VERSION): AppDeps {
  const sleep = device.sleep ?? ((ms: number) => new Promise<void>(done => setTimeout(done, ms)));
  const machine = lockMachine({ core, plugin: device.plugin, close: { files: device.files, sleep, appVersion } });
  return { core, machine, lock: lockActions(machine), store: recordStore(core), clock: minuteClock(core.now), device, random, appVersion };
}

/** Opens storage for this device, asks it to keep the storage safe, and assembles the app. */
export async function composeWith(device: DevicePort, storage: StorageDeps, now: () => number = Date.now): Promise<Composed> {
  const opened = await openStorage(storage, device.files, now);
  if (opened.kind === 'AppTooOld') return opened;
  const kept = await device.persist?.().catch(() => undefined);
  if (kept !== undefined) await writePersisted(opened.db, kept).catch(() => {});
  return { kind: 'Ready', deps: assemble(openRecord({ db: opened.db, now }), device) };
}

export async function compose(): Promise<Composed> {
  return composeWith(await devicePort(), { name: 'daily-commit', indexedDB, IDBKeyRange });
}
