import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lockMachine, screenOf, type LockMachine, type LockState } from '../../src/app/lockMachine.ts';
import type { RecordCore } from '../../src/record/core.ts';
import type { SnapshotFiles } from '../../src/record/files.ts';
import { LATEST } from '../../src/record/backup/snapshot.ts';
import { openSession } from '../../src/record/ops/session.ts';
import { setSetting } from '../../src/record/ops/settings.ts';
import type { BackupCipher, Secret } from '../../src/vault/cipher.ts';
import { enrolMode } from '../../src/vault/devices.ts';
import type { VaultPlugin } from '../../src/vault/plugin.ts';
import { sessionCiphers, unlockWithSecret } from '../../src/vault/vault.ts';
import { memoryFiles } from '../record/memoryFiles.ts';
import { fakePlugin } from '../vault/fakePlugin.ts';
import { PASSPHRASE, realRecord, rowsOf } from './realRecord.ts';

const PASS: Secret = { method: 'passphrase', text: PASSPHRASE };
const never = () => new Promise<void>(() => {});
const kinds = (states: readonly LockState[]) => states.map(s => (s.kind === 'Locked' ? `Locked ${s.offered === undefined ? '?' : `[${s.offered.join()}]`}` : s.kind));
/** The open session, read fresh each time (TypeScript would otherwise remember an earlier check). */
const sessionOf = (core: RecordCore) => core.session;

/** A real record, open after first run, with its machine, its files and a stand-in phone plugin. */
async function setup(options: { plugin?: (p: VaultPlugin) => VaultPlugin; files?: (f: SnapshotFiles, core: RecordCore) => SnapshotFiles; sleep?: () => Promise<void>; core?: (c: RecordCore) => RecordCore } = {}) {
  const r = await realRecord();
  const m = memoryFiles();
  const f = fakePlugin();
  const core = options.core?.(r.core) ?? r.core;
  const machine = lockMachine({
    core,
    plugin: options.plugin?.(f.plugin) ?? f.plugin,
    close: { files: options.files?.(m.files, r.core) ?? m.files, sleep: options.sleep ?? never, appVersion: '0.1.0' },
  });
  const seen: LockState[] = [];
  machine.listen(s => seen.push(s));
  return { ...r, m, f, machine, seen };
}

/** Leaves, then comes back to the lock screen. */
async function lockAndResume(machine: LockMachine) {
  await machine.leave();
  await machine.resume();
}

test('open after first run; leaving blanks the screen at once and ends locked, black until the phone answers', async () => {
  const t = await setup();
  assert.equal(screenOf(t.machine.state), 'record');
  const leaving = t.machine.leave();
  assert.equal(screenOf(t.machine.state), 'blank');            // before anything else has happened
  assert.equal(await leaving, 'written');
  assert.equal(t.core.session, undefined);
  assert.deepEqual(kinds(t.seen), ['Locking', 'Locked ?']);
  assert.equal(screenOf(t.machine.state), 'blank');
});

test('on resume the screen stays black until the phone says which copies exist', async () => {
  let answer!: () => void;
  const asked = new Promise<void>(resolve => { answer = resolve; });
  const t = await setup({ plugin: p => ({ ...p, status: async () => { await asked; return p.status(); } }) });
  await t.machine.leave();
  const resuming = t.machine.resume();
  assert.equal(screenOf(t.machine.state), 'blank');
  answer();
  await resuming;
  assert.deepEqual(t.machine.state, { kind: 'Locked', offered: [] });
  assert.equal(screenOf(t.machine.state), 'lock');
});

test('unlock: a wrong passphrase goes back to the lock screen; the right one opens; an open app can\'t be unlocked again', async () => {
  const t = await setup();
  await lockAndResume(t.machine);
  t.seen.length = 0;
  assert.deepEqual(await t.machine.unlock({ method: 'passphrase', text: 'CANARY wrong' }), { kind: 'WrongSecret' });
  assert.deepEqual(kinds(t.seen), ['Unlocking', 'Locked ?', 'Locked []']);
  assert.deepEqual(await t.machine.unlock(PASS), { kind: 'Open' });
  assert.ok(sessionOf(t.core));
  assert.equal(screenOf(t.machine.state), 'record');
  assert.deepEqual(await t.machine.unlock(PASS), { kind: 'NotLocked' });
});

test('the order on leaving: blank, the snapshot sealed while the keys are there, the keys dropped, then the file written', async () => {
  const order: string[] = [];
  const t = await setup({
    files: (files, core) => ({
      ...files,
      read: async path => { order.push(`read ${path}, keys ${core.session ? 'held' : 'gone'}`); return files.read(path); },
      write: async (path, bytes) => { order.push(`write ${path}, keys ${core.session ? 'held' : 'gone'}`); return files.write(path, bytes); },
    }),
  });
  t.machine.listen(s => order.push(`state ${s.kind}`));
  await setSetting(t.core, 'cuesOn', false);
  assert.equal(await t.machine.leave(), 'written');
  assert.deepEqual(order, ['state Locking', `read ${LATEST}, keys held`, 'write tmp/snapshot.dcbak, keys gone', 'state Locked']);
  assert.ok(t.m.store.get(LATEST));
});

test('leaving while the passphrase is being stretched ends locked, with nothing opened', async () => {
  const t = await setup();
  await lockAndResume(t.machine);
  const unlocking = t.machine.unlock(PASS);
  assert.equal(t.machine.state.kind, 'Unlocking');
  const leaving = t.machine.leave();
  assert.deepEqual(await unlocking, { kind: 'Left' });
  assert.equal(await leaving, 'unchanged');
  assert.equal(t.core.session, undefined);
  assert.deepEqual(t.machine.state, { kind: 'Locked', offered: undefined });
  await t.machine.resume();
  assert.deepEqual(await t.machine.unlock(PASS), { kind: 'Open' });   // and the next unlock works
});

test('leaving just after the record opened, before the unlock finished, closes what it opened', async () => {
  let machine!: LockMachine;
  const t = await setup({
    core: core => {
      const spy: RecordCore = Object.create(core);
      return Object.assign(spy, {
        unlock: async (...args: Parameters<RecordCore['unlock']>) => { await core.unlock(...args); void machine.leave(); },
      });
    },
  });
  machine = t.machine;
  await lockAndResume(machine);
  assert.deepEqual(await machine.unlock(PASS), { kind: 'Left' });
  await machine.leave();
  assert.equal(t.core.session, undefined);
  assert.deepEqual(machine.state, { kind: 'Locked', offered: undefined });
});

test('a save already under way finishes and is in the snapshot; one asked for after leaving began is refused as Locked', async () => {
  const t = await setup();
  const before = setSetting(t.core, 'cuesOn', false);
  const leaving = t.machine.leave();
  const after = setSetting(t.core, 'wakePlan', 400);
  assert.equal((await before).kind, 'Saved');
  assert.deepEqual(await after, { kind: 'Locked' });
  assert.equal(await leaving, 'written');
  await t.machine.resume();
  await t.machine.unlock(PASS);
  assert.equal(sessionOf(t.core)?.model.settings.cuesOn, false);
  assert.equal(sessionOf(t.core)?.model.settings.wakePlan, 390);
});

test('leaving twice closes once', async () => {
  const t = await setup();
  await setSetting(t.core, 'cuesOn', false);
  const first = t.machine.leave();
  const second = t.machine.leave();
  assert.equal(first, second);
  assert.equal(await first, 'written');
  assert.equal(t.m.log.filter(call => call === `rename tmp/snapshot.dcbak ${LATEST}`).length, 1);
  assert.equal(await t.machine.leave(), 'unchanged');                // already locked: nothing to do
});

test('a snapshot past its 3 seconds is abandoned; the keys go all the same and the app ends locked', async () => {
  const t = await setup({ sleep: async () => {} });                  // the uptime clock says the time is up at once
  await setSetting(t.core, 'cuesOn', false);
  assert.equal(await t.machine.leave(), 'abandoned');
  assert.equal(t.core.session, undefined);
  assert.equal(t.m.store.get(LATEST), undefined);
  assert.deepEqual(t.machine.state, { kind: 'Locked', offered: undefined });
});

test('device unlock: phone lock opens; a copy that is gone leaves the lock screen with the choices still there', async () => {
  const t = await setup();
  assert.equal((await enrolMode(await rowsOf(t.core), PASS, t.f.plugin, 'phone-lock')).kind, 'Enrolled');
  await lockAndResume(t.machine);
  assert.deepEqual(t.machine.state, { kind: 'Locked', offered: ['phone-lock'] });
  assert.deepEqual(await t.machine.unlock({ mode: 'phone-lock' }), { kind: 'Open' });
  await lockAndResume(t.machine);
  t.f.invalidate('phone-lock');
  assert.deepEqual(await t.machine.unlock({ mode: 'phone-lock' }), { kind: 'CopyGone', offered: [] });
  assert.deepEqual(t.machine.state, { kind: 'Locked', offered: [] });
});

test('follow: a record locked or opened outside the machine is followed', async () => {
  const t = await setup();
  await t.core.lock();
  await t.machine.follow();
  assert.deepEqual(t.machine.state, { kind: 'Locked', offered: [] });
  await t.machine.unlock(PASS);
  assert.equal(t.machine.state.kind, 'Open');
});

// ── Two things at once (review R1). The machine never trusts its own label: it waits for anything
// under way, then reads whether the record is really open, and the phone's answer only draws the
// lock screen while the app is in front.

/** A promise held shut until `open()`, and a signal that something reached it. */
function gate() {
  let open!: () => void;
  let reached!: () => void;
  const shut = new Promise<void>(resolve => { open = resolve; });
  const arrived = new Promise<void>(resolve => { reached = resolve; });
  return { open, arrived, wait: async () => { reached(); await shut; } };
}

/** Files whose read of the latest snapshot (the seal) or write of the new one waits at a gate. */
const heldAt = (g: ReturnType<typeof gate>, at: 'seal' | 'write') => (files: SnapshotFiles): SnapshotFiles => ({
  ...files,
  read: async path => { if (at === 'seal' && path === LATEST) await g.wait(); return files.read(path); },
  write: async (path, bytes) => { if (at === 'write' && path === 'tmp/snapshot.dcbak') await g.wait(); return files.write(path, bytes); },
});

/** A phone whose unlock prompt waits at a gate. */
const promptHeld = (g: ReturnType<typeof gate>) => (p: VaultPlugin): VaultPlugin => ({ ...p, unwrap: async mode => { await g.wait(); return p.unwrap(mode); } });

test('R1-1: leaving drops a record opened outside the machine, even while the machine says Locked', async () => {
  const t = await setup();
  await lockAndResume(t.machine);
  const opened = await unlockWithSecret(await rowsOf(t.core), PASS);
  if (opened.kind !== 'Unlocked') throw new Error(opened.kind);
  const { cipher, backup } = sessionCiphers(opened.keys);
  await openSession(t.core, cipher, backup);                         // first run or a restore, before follow()
  assert.equal(t.machine.state.kind, 'Locked');
  await t.machine.leave();
  assert.equal(t.core.session, undefined);
  assert.deepEqual(await setSetting(t.core, 'cuesOn', false), { kind: 'Locked' });
});

test('R1-2: follow during an unlock waits for it, so a leave in between still ends locked', async () => {
  const g = gate();
  const t = await setup({ plugin: promptHeld(g) });
  assert.equal((await enrolMode(await rowsOf(t.core), PASS, t.f.plugin, 'phone-lock')).kind, 'Enrolled');
  await lockAndResume(t.machine);
  const unlocking = t.machine.unlock({ mode: 'phone-lock' });
  await g.arrived;
  const following = t.machine.follow();
  const leaving = t.machine.leave();
  g.open();
  assert.deepEqual(await unlocking, { kind: 'Left' });
  await leaving;
  await following;
  assert.equal(t.core.session, undefined);
  assert.equal(screenOf(t.machine.state), 'blank');
});

test('R1-3: while the snapshot is being written nothing can unlock, and the lock\'s end never covers an open record', async () => {
  const g = gate();
  const t = await setup({ files: heldAt(g, 'write') });
  assert.equal((await enrolMode(await rowsOf(t.core), PASS, t.f.plugin, 'phone-lock')).kind, 'Enrolled');
  await setSetting(t.core, 'cuesOn', false);
  const leaving = t.machine.leave();
  await g.arrived;
  const following = t.machine.follow();
  assert.deepEqual(await t.machine.unlock({ mode: 'phone-lock' }), { kind: 'NotLocked' });
  g.open();
  assert.equal(await leaving, 'written');
  await following;
  assert.equal(t.core.session, undefined);
  assert.equal(t.machine.state.kind, 'Locked');
});

test('R1-5: the screen coming back while the lock is still sealing shows the lock screen once the lock is done', async () => {
  const g = gate();
  const t = await setup({ files: heldAt(g, 'seal') });
  const leaving = t.machine.leave();
  await g.arrived;
  const resuming = t.machine.resume();
  g.open();
  await leaving;
  await resuming;
  assert.deepEqual(t.machine.state, { kind: 'Locked', offered: [] });
  assert.equal(screenOf(t.machine.state), 'lock');
});

test('R1-5: the screen coming back while a leave waits on an unlock shows the lock screen once both are done', async () => {
  const g = gate();
  const t = await setup({ plugin: promptHeld(g) });
  assert.equal((await enrolMode(await rowsOf(t.core), PASS, t.f.plugin, 'phone-lock')).kind, 'Enrolled');
  await lockAndResume(t.machine);
  const unlocking = t.machine.unlock({ mode: 'phone-lock' });
  await g.arrived;
  const leaving = t.machine.leave();
  const resuming = t.machine.resume();
  g.open();
  assert.deepEqual(await unlocking, { kind: 'Left' });
  await leaving;
  await resuming;
  assert.equal(t.core.session, undefined);
  assert.equal(screenOf(t.machine.state), 'lock');
});

test('R1-6: a screen that throws while drawing never stops the lock or sticks the machine', async () => {
  const t = await setup();
  const heard: string[] = [];
  t.machine.listen(s => { if (s.kind === 'Locking' || s.kind === 'Unlocking') throw new Error('a screen failed to draw'); });
  t.machine.listen(s => heard.push(s.kind));
  assert.equal(await t.machine.leave(), 'written');               // the first lock after first run writes a snapshot
  assert.equal(t.core.session, undefined);
  assert.deepEqual(heard, ['Locking', 'Locked']);                    // the other screens still heard every change
  await t.machine.resume();
  assert.deepEqual(await t.machine.unlock(PASS), { kind: 'Open' });
});

test('R1-7: follow while the snapshot is sealing keeps the screen black', async () => {
  const g = gate();
  const t = await setup({ files: heldAt(g, 'seal') });
  const leaving = t.machine.leave();
  await g.arrived;
  const following = t.machine.follow();
  assert.equal(screenOf(t.machine.state), 'blank');
  g.open();
  await leaving;
  await following;
  assert.equal(t.core.session, undefined);
  assert.equal(screenOf(t.machine.state), 'blank');                 // the app was left: black until it comes back
});

test('R1-11: leaving while the phone is asked after a wrong passphrase keeps the screen black', async () => {
  const g = gate();
  let hold = false;
  const t = await setup({ plugin: p => ({ ...p, status: async () => { if (hold) await g.wait(); return p.status(); } }) });
  await lockAndResume(t.machine);
  hold = true;
  const unlocking = t.machine.unlock({ method: 'passphrase', text: 'CANARY wrong' });
  await g.arrived;
  const leaving = t.machine.leave();                                 // it waits for the unlock, which waits for the phone
  g.open();
  assert.deepEqual(await unlocking, { kind: 'WrongSecret' });
  await leaving;
  assert.equal(screenOf(t.machine.state), 'blank');
});

test('R1-9: a snapshot abandoned at its 3 seconds can\'t start using the backup key once the lock has passed', async () => {
  const g = gate();
  const t = await setup({ files: heldAt(g, 'seal'), sleep: async () => {} });
  const live = sessionOf(t.core);
  if (!live?.backup) throw new Error('no backup key');
  const inner = live.backup;
  let sealedAfterLock = false;
  (live as { backup: BackupCipher }).backup = {
    sealBody: async (body, header, iv) => { if (t.core.session === undefined) sealedAfterLock = true; return inner.sealBody(body, header, iv); },
    openBody: (...args) => inner.openBody(...args),
  };
  await setSetting(t.core, 'cuesOn', false);
  const leaving = t.machine.leave();
  await g.arrived;
  assert.equal(await leaving, 'abandoned');
  assert.equal(t.core.session, undefined);
  g.open();
  await new Promise(resolve => setTimeout(resolve, 200));           // the abandoned seal runs on, and is refused
  assert.equal(sealedAfterLock, false);
});
