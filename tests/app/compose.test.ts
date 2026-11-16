import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Dexie from 'dexie';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { assemble, composeWith, errorType, openingView, startWith } from '../../src/app/compose.ts';
import type { DevicePort } from '../../src/app/context.ts';
import { memoryFiles } from '../../src/device/browser.ts';
import { SNAPSHOT_CAP_MS } from '../../src/record/backup/snapshot.ts';
import { SCHEMA_VERSION } from '../../src/record/db.ts';
import { readPersisted } from '../../src/record/ops/device.ts';
import { fakePlugin } from '../vault/fakePlugin.ts';
import { realRecord } from './realRecord.ts';

const port = (over: Partial<DevicePort> = {}): DevicePort => ({
  plugin: fakePlugin().plugin, deviceModes: true, files: memoryFiles(), onLeave: () => () => {}, onResume: () => () => {}, ...over,
});

test('C10: a record saved by a newer app is refused before anything opens it', async () => {
  const indexedDB = new IDBFactory();
  const newer = new Dexie('dc-test', { indexedDB, IDBKeyRange });
  newer.version(SCHEMA_VERSION + 1).stores({ device: 'key' });
  await newer.open();
  newer.close();
  assert.deepEqual(await composeWith(port(), { name: 'dc-test', indexedDB, IDBKeyRange }), { kind: 'AppTooOld' });
});

test('C11: the phone is asked to keep the storage at every start, and its answer is kept on this device', async () => {
  let asked = 0;
  const made = await composeWith(port({ persist: async () => { asked += 1; return true; } }), { name: 'dc-test', indexedDB: new IDBFactory(), IDBKeyRange });
  assert.equal(made.kind, 'Ready');
  if (made.kind !== 'Ready') return;
  made.deps.clock.stop();
  assert.equal(asked, 1);                                     // a compose that never calls persist and stores false still fails
  assert.equal(await readPersisted(made.deps.core.db), true);
});

test('C15: on the phone the snapshot\'s 3-second cap runs on the phone\'s own clock', async () => {
  const r = await realRecord();
  const waited: number[] = [];
  const armed: number[] = [];
  const ids: number[] = [];
  const orig = globalThis.setTimeout;
  globalThis.setTimeout = ((fn: TimerHandler, ms?: number) => {
    armed.push(Number(ms));
    const id = orig(fn, ms) as unknown as number;
    ids.push(id);
    return id;
  }) as typeof setTimeout;
  try {
    const deps = assemble(r.core, port({ sleep: ms => { waited.push(ms); return new Promise<void>(() => {}); } }));
    deps.clock.stop();
    assert.equal(await deps.machine.leave(), 'written');
    assert.ok(waited.includes(SNAPSHOT_CAP_MS), String(waited));
    assert.equal(armed.includes(SNAPSHOT_CAP_MS), false, String(armed));   // the phone clock is not raced against a JavaScript timer
  } finally {
    for (const id of ids) clearTimeout(id);
    globalThis.setTimeout = orig;
  }
});

test('D-37: a start that failed says so; it is never shown as an app that is too old', () => {
  assert.equal(openingView(undefined), 'failed');
  assert.equal(openingView({ kind: 'StartFailed', step: 'storage', error: 'Error' }), 'failed');
  assert.equal(openingView({ kind: 'AppTooOld' }), 'too-old');
  assert.equal(openingView({ kind: 'Ready', deps: {} as never }), 'ready');
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../src/main.tsx'), 'utf8');
  // The rejection handler is what stops a thrown compose() leaving the splash up. Absent on the old main.
  assert.match(src, /\.then\(\s*show\s*,\s*\(\)\s*=>\s*show\(undefined\)\s*\)/);
  assert.match(src, /openingView\(made\)/);
  assert.match(src, /view === 'too-old' \? <TooOld/);
  assert.match(src, /<StartFailed /);
});

/** The phone's ShellFiles as the record meets it: a folder not on its list is refused. */
function phoneFiles(allowed: readonly string[]) {
  const files = memoryFiles();
  const check = (path: string) => {
    if (!allowed.includes(path.split('/')[0] ?? '')) throw new Error('path');
  };
  return {
    write: async (p: string, b: Uint8Array) => { check(p); return files.write(p, b); },
    read: async (p: string) => { check(p); return files.read(p); },
    rename: async (a: string, b: string) => { check(a); check(b); return files.rename(a, b); },
    list: async (d: string) => { check(d); return files.list(d); },
    remove: async (p: string) => { check(p); return files.remove(p); },
  };
}

const PHONE_FOLDERS = (() => {
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../android/app/src/main/java/app/dailycommit/shell/ShellFiles.java'), 'utf8');
  return [...(/FOLDERS = Set\.of\(([^)]*)\)/.exec(src)?.[1] ?? '').matchAll(/"([^"]+)"/g)].map(m => m[1] ?? '');
})();

test('D-37: a fresh start opens on the phone\'s own folder list; with the list before log-replaced/ it fails at storage, said plainly', async () => {
  const fresh = () => ({ name: 'dc-test', indexedDB: new IDBFactory(), IDBKeyRange });
  const made = await startWith(async () => port({ files: phoneFiles(PHONE_FOLDERS) }), fresh());
  assert.equal(made.kind, 'Ready');
  if (made.kind === 'Ready') made.deps.clock.stop();
  // the tablet run of 16 Nov: every start of that build stopped here and showed "older than your record"
  const before = await startWith(async () => port({ files: phoneFiles(['backup', 'tmp', 'safety', 'preupgrade']) }), fresh());
  assert.deepEqual(before, { kind: 'StartFailed', step: 'storage', error: 'Error' });
});

test('D-37: a phone that can\'t be reached fails at the device step; the error\'s type is kept, never its message', async () => {
  const failed = await startWith(async () => { throw new TypeError('CANARY-TEST secret words'); }, { name: 'dc-test', indexedDB: new IDBFactory(), IDBKeyRange });
  assert.deepEqual(failed, { kind: 'StartFailed', step: 'device', error: 'TypeError' });
  assert.equal(errorType(Object.assign(new Error('x'), { name: 'CANARY TEST words' })), 'Error');
  assert.equal(errorType('a string'), 'Error');
});
