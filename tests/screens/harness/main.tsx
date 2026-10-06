// The harness page: the state from the URL, a fresh invented record (or one handed in, fixture.ts), the stand-in phone, then the
// real app. Every state starts from nothing: changing the hash reloads the page.
import { setSetting } from '../../../src/record/ops/settings.ts';
import { createRoot } from 'react-dom/client';
import { App } from '../../../src/app/App.tsx';
import { minuteClock } from '../../../src/app/clock.ts';
import { assemble } from '../../../src/app/compose.ts';
import type { AppDeps, DevicePort, Nav, ScreenId, UnlockHow } from '../../../src/app/context.ts';
import { memoryFiles } from '../../../src/device/browser.ts';
import { openRecord, type RecordCore, type WriteSpec } from '../../../src/record/core.ts';
import { openDb } from '../../../src/record/db.ts';
import { exportBackup } from '../../../src/record/backup/export.ts';
import { frame, readFrame } from '../../../src/record/backup/format.ts';
import { LATEST } from '../../../src/record/backup/snapshot.ts';
import { jsonBytes, toBase64url } from '../../../src/record/bytes.ts';
import { vaultRows } from '../../../src/record/ops/vault.ts';
import { enrolMode } from '../../../src/vault/devices.ts';
import { fakePlugin } from '../../vault/fakePlugin.ts';
import '../../../src/ui/fonts.css';
import '../../../src/ui/app.css';
import { seedFixture } from './fixture.ts';
import { HARNESS_CODE, HARNESS_PASSPHRASE, seedRecord } from './seed.ts';
import { dateOfDay, nowOf, readState, type HarnessState } from './state.ts';
import { closeDay } from '../../../src/record/ops/days.ts';

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
  /** a backup file for the restore flows, as base64url: another record's, this one's, a newer one or a damaged one */
  backup(kind: 'source' | 'mine' | 'newer' | 'damaged'): Promise<string>;
  /** from now on the phone's key store refuses to save a key, as one with no secure screen lock does */
  refuseEnrol(): void;
  /** from now on the copy kept before a replace can't be written: the phone is full, or the write fails otherwise */
  failCopy(why: 'full' | 'other'): void;
  /** the next time the phone asks for its lock or a fingerprint, the person backs out */
  cancelPrompt(): void;
  /** the next copy the phone opens gives back something else, so a new copy can't be confirmed */
  failCheck(): void;
  /** the next write to the record throws, as a storage fault other than a full phone would, so the screen must say so itself */
  failWrite(): void;
  /** the clock moves on by this many minutes, and the screens draw again as they do at each new minute */
  moveClock(minutes: number): void;
  /** the words the invented record holds for a day number: the morning intent and the evening remark */
  dayWords(day: number): { readonly intent?: string; readonly remark?: string };
  /** the value the invented record holds for a habit on a day number, if any */
  dayValue(day: number, habitId: string): number | string | undefined;
  /** this phone moves to a code of its own with the fingerprint beside it, as Settings would set them up */
  ownCode(): Promise<void>;
  /** the invented record's recovery code, as the first day would have shown it (none for an empty record) */
  readonly recoveryCode: string | undefined;
}

/** A backup of a second invented record, made in its own database. */
async function sourceBackup(state: HarnessState): Promise<Uint8Array> {
  const name = `${DB_NAME}-source`;
  await deleteDb(name);
  const { core } = await seedRecord(openDb({ name, indexedDB, IDBKeyRange }), { ...state, day: 12 });
  return backupOf(core);
}

async function backupOf(core: RecordCore): Promise<Uint8Array> {
  const made = await exportBackup(core, { appVersion: '0.1.0' });
  if (made.kind !== 'Saved') throw new Error(`harness backup: ${made.kind}`);
  return made.value.bytes;
}

/** The same file under a header that names a later format. */
function newerOf(file: Uint8Array): Uint8Array {
  const f = readFrame(file);
  return frame(jsonBytes({ ...f.header, format_version: f.header.format_version + 1 }), f.ct);
}

/** The same file with one byte of its locked body changed. */
function damagedOf(file: Uint8Array): Uint8Array {
  const bytes = file.slice();
  const at = bytes.length - 20;
  bytes[at] = (bytes[at] ?? 0) ^ 1;
  return bytes;
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

/** Wraps a record core so a flow can make its next write throw something other than quota-full,
 * the way an aborted transaction or a closed connection would. */
function failableCore(core: RecordCore): { readonly core: RecordCore; failNext(): void } {
  let failing = false;
  return {
    core: {
      db: core.db,
      now: core.now,
      get session() { return core.session; },
      newId: core.newId,
      hasVault: core.hasVault,
      unlock: core.unlock,
      lock: core.lock,
      write<T>(spec: WriteSpec<T>) {
        if (failing) { failing = false; return Promise.reject(new Error('CANARY-TEST injected write failure')); }
        return core.write(spec);
      },
      serial: core.serial,
      commit: core.commit,
    },
    failNext: () => { failing = true; },
  };
}

/** A device port around the stand-in plugin; leaving and coming back are driven by the flows. */
function harnessDevice(plugin: DevicePort['plugin']) {
  const leaving = new Set<() => void>();
  const resuming = new Set<() => void>();
  const stored = memoryFiles();
  let failing: 'full' | 'other' | undefined;
  const device: DevicePort = {
    plugin,
    deviceModes: true,
    files: {
      ...stored,
      write: (path, bytes) => (failing && path.startsWith('tmp/safety')
        ? Promise.reject(failing === 'full' ? new DOMException('no space left', 'QuotaExceededError') : new Error('write failed'))
        : stored.write(path, bytes)),
    },
    onLeave(cb) { leaving.add(cb); return () => { leaving.delete(cb); }; },
    onResume(cb) { resuming.add(cb); return () => { resuming.delete(cb); }; },
    // the phone's "save as": the flows read the name of what was saved
    async saveFile(name) { document.documentElement.dataset.saved = name; return true; },
    async spaceUsed() { return 2.4 * 1024 * 1024; },
  };
  return {
    device,
    leave: () => { for (const cb of leaving) cb(); },
    resume: () => { for (const cb of resuming) cb(); },
    failCopy: (why: 'full' | 'other') => { failing = why; },
  };
}

/** The device copies a lock state starts with. */
async function enrolFor(state: HarnessState, core: RecordCore, phone: ReturnType<typeof fakePlugin>): Promise<void> {
  const rows = await vaultRows(core);
  if (!rows || state.variant === 'pass' || state.variant === 'damaged') return;
  if (['own', 'five', 'newfinger'].includes(state.variant)) {
    await enrolMode(rows, PASS, phone.plugin, 'own-code', HARNESS_CODE);
    await enrolMode(rows, PASS, phone.plugin, 'fingerprint');
  } else {
    await enrolMode(rows, PASS, phone.plugin, 'phone-lock');
  }
}

/** What happened before the screen is drawn, for the states that show an outcome. */
async function prelude(state: HarnessState, deps: AppDeps, phone: ReturnType<typeof fakePlugin>): Promise<void> {
  if (state.screen === 'today' && state.variant === 'closed') {
    const today = dateOfDay(state.day, state.start);
    await deps.store.run(core => closeDay(core, { date: today, lightsOut: state.minute }));
  }
  if (state.variant === 'paused') await deps.store.run(core => setSetting(core, 'paused', true));
  if (state.screen !== 'lock') return;
  if (state.variant === 'damaged') await deps.lock.unlock(PASS);   // refused: the record's lock is damaged
  if (state.variant === 'five') for (let i = 0; i < 5; i++) await deps.lock.unlock({ mode: 'own-code', code: '000000' });
  if (state.variant === 'newfinger') {
    phone.invalidate('fingerprint');
    await deps.lock.unlock({ mode: 'fingerprint' });
  }
}

async function start(): Promise<void> {
  const fixture = window.harnessFixture;
  const state = readState(location.hash, fixture?.start);
  await deleteDb(DB_NAME);
  const db = openDb({ name: DB_NAME, indexedDB, IDBKeyRange });
  const phone = fakePlugin();
  let core: RecordCore;
  let recoveryCode: string | undefined;
  let setNow: ((ms: number) => void) | undefined;
  const empty = state.screen === 'first' || (state.screen === 'restore' && state.variant !== 'replace');
  if (empty) {
    const now = nowOf(state);
    core = openRecord({ db, now: () => now });
  } else {
    let clock: { set(ms: number): void };
    ({ core, recoveryCode, clock } = fixture ? await seedFixture(db, state, fixture) : await seedRecord(db, state));
    setNow = clock.set;
  }
  // a record whose lock is damaged: its own backup and the phone's last copy were made while it still opened
  const damaged = state.screen === 'lock' && state.variant === 'damaged';
  const mineBefore = damaged ? await backupOf(core) : undefined;
  if (state.screen === 'lock') {
    await enrolFor(state, core, phone);
    await core.lock();
  }
  if (damaged) await db.vault.update('main', { kid: 'CANARY-damaged' });
  if (state.screen === 'settings' || state.screen === 'secret') {
    const rows = await vaultRows(core);
    if (rows) await enrolMode(rows, PASS, phone.plugin, 'phone-lock');   // the first day's default on a phone
  }
  let refusing = false;
  const plugin: DevicePort['plugin'] = { ...phone.plugin, enrol: (...a) => (refusing ? Promise.reject(new Error('key store refused')) : phone.plugin.enrol(...a)) };
  const { device, leave, resume, failCopy } = harnessDevice(plugin);
  const { core: writable, failNext: failWrite } = failableCore(core);
  // the harness's time stands still, so its minute clock ticks only when a flow moves the clock on
  let tick = () => {};
  const assembled = assemble(writable, device);
  assembled.clock.stop();
  const deps = { ...assembled, clock: minuteClock(writable.now, run => { tick = run; return undefined; }, () => {}) };
  await prelude(state, deps, phone);
  let source: Promise<Uint8Array> | undefined;
  const sourceFile = () => (source ??= sourceBackup(state));
  if (state.screen === 'first' && state.variant === 'found') await device.files.write(LATEST, await sourceFile());
  if (mineBefore) await device.files.write(LATEST, mineBefore);
  window.harness = {
    leave: async () => { leave(); await deps.machine.leave(); },
    resume: async () => { resume(); await deps.machine.resume(); },
    unlock: async how => (await deps.lock.unlock(how)).kind,
    backup: async kind => {
      const file = kind === 'mine' ? (mineBefore ?? await backupOf(core)) : await sourceFile();
      return toBase64url(kind === 'newer' ? newerOf(file) : kind === 'damaged' ? damagedOf(file) : file);
    },
    refuseEnrol: () => { refusing = true; },
    failCopy,
    cancelPrompt: () => phone.cancelNext(),
    failCheck: () => phone.lieNext('not-a-key'),
    failWrite,
    moveClock: minutes => {
      if (!setNow) throw new Error('harness: this state has no clock to move');
      setNow(core.now() + minutes * 60_000);
      tick();
    },
    dayWords: day => {
      const d = core.session?.model.days.get(dateOfDay(day, state.start));
      return { intent: d?.intent, remark: d?.remark };
    },
    dayValue: (day, habitId) => core.session?.model.observations.get(`${habitId}|${dateOfDay(day, state.start)}`)?.value,
    ownCode: () => enrolFor({ ...state, variant: 'own' }, core, phone),
    recoveryCode,
  };
  const initial: Nav | undefined = (SCREENS as readonly string[]).includes(state.screen) ? { screen: state.screen as ScreenId, variant: state.variant } : undefined;
  const root = document.getElementById('root');
  if (!root) throw new Error('harness: #root is missing');
  createRoot(root).render(<><App deps={deps} initial={initial} /><span data-harness-ready="" hidden /></>);
}

window.addEventListener('hashchange', () => location.reload());
void start();
