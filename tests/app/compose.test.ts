import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Dexie from 'dexie';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { assemble, composeWith, openingView } from '../../src/app/compose.ts';
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

test('a compose() that throws takes the same black first paint as an app that is too old', () => {
  assert.equal(openingView(undefined), 'black');
  assert.equal(openingView({ kind: 'AppTooOld' }), 'black');
  assert.equal(openingView({ kind: 'Ready', deps: {} as never }), 'ready');
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../src/main.tsx'), 'utf8');
  // The rejection handler is what stops a thrown compose() leaving the splash up. Absent on the old main.
  assert.match(src, /\.then\(\s*show\s*,\s*\(\)\s*=>\s*show\(undefined\)\s*\)/);
  assert.match(src, /openingView\(made\)/);
});
