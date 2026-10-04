import { openDb } from '../record/db.ts';
import { openRecord, type RecordCore } from '../record/core.ts';
import { browserPort } from '../device/browser.ts';
import { systemRandom, type Random } from '../vault/random.ts';
import { minuteClock } from './clock.ts';
import type { AppDeps, DevicePort } from './context.ts';
import { lockMachine } from './lockMachine.ts';
import { lockActions } from './lockNotes.ts';
import { recordStore } from './store.ts';

// Builds what the app runs on. The release app uses the browser port until the phone's arrives;
// the screen harness assembles the same pieces around its invented record.

export const APP_VERSION = '0.1.0';

/**
 * The pieces around a record and a device. In a browser the snapshot's 3-second cap runs on a
 * JavaScript timer; on the phone it runs on the uptime clock, which Android can't hold back.
 */
export function assemble(core: RecordCore, device: DevicePort, random: Random = systemRandom, appVersion = APP_VERSION): AppDeps {
  const sleep = (ms: number) => new Promise<void>(done => setTimeout(done, ms));
  const machine = lockMachine({ core, plugin: device.plugin, close: { files: device.files, sleep, appVersion } });
  return { core, machine, lock: lockActions(machine), store: recordStore(core), clock: minuteClock(core.now), device, random, appVersion };
}

export function compose(): AppDeps {
  const db = openDb({ name: 'daily-commit', indexedDB, IDBKeyRange });
  return assemble(openRecord({ db, now: Date.now }), browserPort());
}
