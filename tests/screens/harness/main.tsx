// The harness page: the state from the URL, a fresh invented record, the stand-in phone, then the
// real app. Every state starts from nothing: changing the hash reloads the page.
import { createRoot } from 'react-dom/client';
import { App } from '../../../src/app/App.tsx';
import { assemble } from '../../../src/app/compose.ts';
import type { AppDeps, DevicePort, Nav, ScreenId, UnlockHow } from '../../../src/app/context.ts';
import { memoryFiles } from '../../../src/device/browser.ts';
import { openRecord, type RecordCore } from '../../../src/record/core.ts';
import { openDb } from '../../../src/record/db.ts';
import { vaultRows } from '../../../src/record/ops/vault.ts';
import { enrolMode } from '../../../src/vault/devices.ts';
import { fakePlugin } from '../../vault/fakePlugin.ts';
import '../../../src/ui/fonts.css';
import '../../../src/ui/app.css';
import { HARNESS_CODE, HARNESS_PASSPHRASE, seedRecord } from './seed.ts';
import { nowOf, readState, type HarnessState } from './state.ts';

const DB_NAME = 'daily-commit-harness';
const SCREENS: readonly ScreenId[] = ['today', 'look', 'habit', 'week', 'month', 'diary', 'notyet', 'plan', 'settings', 'support', 'restore', 'secret'];
const PASS = { method: 'passphrase', text: HARNESS_PASSPHRASE } as const;

/** What the flows can ask of the page. */
export interface HarnessControls {
  /** the app was left (the screen went off) */
  leave(): Promise<void>;
  /** the app came back to the front */
  resume(): Promise<void>;
  unlock(how: UnlockHow): Promise<string>;
}

declare global {
  interface Window { harness?: HarnessControls }
}

async function deleteDb(name: string): Promise<void> {
  await new Promise<void>((done, failed) => {
    const req = indexedDB.deleteDatabase(name);
    req.onsuccess = () => done();
    req.onerror = () => failed(req.error);
    req.onblocked = () => done();
  });
}

/** A device port around the stand-in plugin; leaving and coming back are driven by the flows. */
function harnessDevice(plugin: DevicePort['plugin']) {
  const leaving = new Set<() => void>();
  const resuming = new Set<() => void>();
  const device: DevicePort = {
    plugin,
    deviceModes: true,
    files: memoryFiles(),
    onLeave(cb) { leaving.add(cb); return () => { leaving.delete(cb); }; },
    onResume(cb) { resuming.add(cb); return () => { resuming.delete(cb); }; },
  };
  return { device, leave: () => { for (const cb of leaving) cb(); }, resume: () => { for (const cb of resuming) cb(); } };
}

/** The device copies a lock state starts with. */
async function enrolFor(state: HarnessState, core: RecordCore, phone: ReturnType<typeof fakePlugin>): Promise<void> {
  const rows = await vaultRows(core);
  if (!rows || state.variant === 'pass') return;
  if (['own', 'five', 'newfinger'].includes(state.variant)) {
    await enrolMode(rows, PASS, phone.plugin, 'own-code', HARNESS_CODE);
    await enrolMode(rows, PASS, phone.plugin, 'fingerprint');
  } else {
    await enrolMode(rows, PASS, phone.plugin, 'phone-lock');
  }
}

/** What happened before the screen is drawn, for the states that show an outcome. */
async function prelude(state: HarnessState, deps: AppDeps, phone: ReturnType<typeof fakePlugin>): Promise<void> {
  if (state.screen !== 'lock') return;
  if (state.variant === 'five') for (let i = 0; i < 5; i++) await deps.lock.unlock({ mode: 'own-code', code: '000000' });
  if (state.variant === 'newfinger') {
    phone.invalidate('fingerprint');
    await deps.lock.unlock({ mode: 'fingerprint' });
  }
}

async function start(): Promise<void> {
  const state = readState(location.hash);
  await deleteDb(DB_NAME);
  const db = openDb({ name: DB_NAME, indexedDB, IDBKeyRange });
  const phone = fakePlugin();
  let core: RecordCore;
  if (state.screen === 'first' || state.screen === 'restore') {
    const now = nowOf(state);
    core = openRecord({ db, now: () => now });
  } else {
    core = (await seedRecord(db, state)).core;
  }
  if (state.screen === 'lock') {
    await enrolFor(state, core, phone);
    await core.lock();
  }
  const { device, leave, resume } = harnessDevice(phone.plugin);
  const deps = assemble(core, device);
  await prelude(state, deps, phone);
  window.harness = {
    leave: async () => { leave(); await deps.machine.leave(); },
    resume: async () => { resume(); await deps.machine.resume(); },
    unlock: async how => (await deps.lock.unlock(how)).kind,
  };
  const initial: Nav | undefined = (SCREENS as readonly string[]).includes(state.screen) ? { screen: state.screen as ScreenId, variant: state.variant } : undefined;
  const root = document.getElementById('root');
  if (!root) throw new Error('harness: #root is missing');
  createRoot(root).render(<><App deps={deps} initial={initial} /><span data-harness-ready="" hidden /></>);
}

window.addEventListener('hashchange', () => location.reload());
void start();
