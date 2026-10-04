// The app's pieces around a test record: the real lock machine, store and clock, with the stand-in
// phone plugin and files in memory. Invented data only.
import { assemble } from '../../src/app/compose.ts';
import type { AppDeps, DevicePort } from '../../src/app/context.ts';
import type { RecordCore } from '../../src/record/core.ts';
import { openRecord } from '../../src/record/core.ts';
import { memoryFiles } from '../../src/device/browser.ts';
import { freshDb } from '../record/helpers.ts';
import { testClock } from '../record/fixtures.ts';
import { fakePlugin } from '../vault/fakePlugin.ts';

export function testDeps(core: RecordCore, options: { readonly deviceModes?: boolean } = {}) {
  const phone = fakePlugin();
  const device: DevicePort = {
    plugin: phone.plugin, deviceModes: options.deviceModes ?? true, files: memoryFiles(),
    onLeave: () => () => {}, onResume: () => () => {},
  };
  const deps: AppDeps = assemble(core, device);
  deps.clock.stop();                                      // tests move no real time
  return { deps, phone };
}

/** An empty record (no first run yet) on a fresh database, its clock on 2026-01-05 09:00 (UTC). */
export function emptyApp(options: { readonly deviceModes?: boolean } = {}) {
  const db = freshDb();
  const clock = testClock('2026-01-05T09:00:00Z');
  const core = openRecord({ db, now: clock.now });
  return { db, clock, core, ...testDeps(core, options) };
}
