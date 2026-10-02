import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openRecord } from '../../src/record/core.ts';
import { firstRun } from '../../src/record/ops/firstRun.ts';
import { setSetting } from '../../src/record/ops/settings.ts';
import { rulesInput } from '../../src/record/read.ts';
import type { RecordDb } from '../../src/record/db.ts';
import { freshDb } from './helpers.ts';
import { stubCipher } from './stubCipher.ts';
import { guarded } from './txGuard.ts';
import { failAtRow } from './faults.ts';
import { SETTINGS, VAULT, WRAPPERS, testClock } from './fixtures.ts';

const cipher = () => guarded(stubCipher());
const setup = { vault: VAULT, wrappers: WRAPPERS, settings: SETTINGS };

function begin(db: RecordDb = freshDb()) {
  const clock = testClock('2026-01-05T09:00:00Z');
  return { db, clock, core: openRecord({ db, now: clock.now }) };
}

async function opened(db?: RecordDb) {
  const t = begin(db);
  assert.equal((await firstRun(t.core, { cipher: cipher(), ...setup })).kind, 'Saved');
  return t;
}

test('before first run there is no vault, and a write is refused as locked', async () => {
  const { core } = begin();
  assert.equal(await core.hasVault(), false);
  assert.deepEqual(await setSetting(core, 'cuesOn', false), { kind: 'Locked' });
});

test('first run writes the vault, both wrappers, the settings and this device together, then opens the record', async () => {
  const { core, db } = await opened();
  assert.equal(await core.hasVault(), true);
  assert.deepEqual(core.session?.model.settings, SETTINGS);
  assert.equal(await db.wrappers.count(), 2);
  assert.equal(await db.settings.count(), 6);
  const device = await db.device.get('device_id');
  assert.equal(core.session?.deviceId, device?.value);
  for (const row of await db.settings.toArray()) {
    assert.deepEqual(Object.keys(row).sort(), ['key', 'r', 'updated_at', 'updated_by']);   // nothing else is plain
    assert.equal(row.updated_by, device?.value);
  }
});

test('a first run that fails at any row leaves nothing behind, so it simply starts again', async () => {
  for (let n = 1; n <= 10; n++) {                     // 2 wrappers, the vault, 6 settings, the device id
    const db = freshDb();
    db.use(failAtRow(n));
    const { core } = begin(db);
    await assert.rejects(firstRun(core, { cipher: cipher(), ...setup }), /injected failure/, `row ${n}`);
    assert.equal(await core.hasVault(), false, `row ${n}`);
    for (const table of db.tables) assert.equal(await table.count(), 0, `${table.name} after a failure at row ${n}`);
    assert.equal(core.session, undefined);
  }
});

test('first run is refused once a vault exists', async () => {
  const { core } = await opened();
  assert.deepEqual(await firstRun(core, { cipher: cipher(), ...setup }), { kind: 'Invalid', reason: 'already set up' });
});

test('settings that make no sense are refused before anything is written', async () => {
  const { core } = begin();
  assert.equal((await firstRun(core, { cipher: cipher(), ...setup, settings: { ...SETTINGS, tz: 'Not/AZone' } })).kind, 'Invalid');
  assert.equal(await core.hasVault(), false);
});

test('a setting saved is in memory and in storage, locked', async () => {
  const { core, db } = await opened();
  assert.deepEqual(await setSetting(core, 'wakePlan', 400), { kind: 'Saved', value: undefined });
  assert.equal(core.session?.model.settings.wakePlan, 400);
  assert.equal((await db.settings.get('wake_plan'))?.r?.v, 1);
  assert.equal((await setSetting(core, 'boundary', 2000)).kind, 'Invalid');
});

test('a full disk is reported as QuotaFull, and nothing changes in storage or in memory', async () => {
  const db = freshDb();
  db.use(failAtRow(11, () => new DOMException('disk full', 'QuotaExceededError')));   // first run writes 10 rows
  const { core } = await opened(db);
  const before = await db.settings.get('wake_plan');
  assert.deepEqual(await setSetting(core, 'wakePlan', 400), { kind: 'QuotaFull' });
  assert.deepEqual(await db.settings.get('wake_plan'), before);
  assert.equal(core.session?.model.settings.wakePlan, 390);
});

test('a change stamp never goes backwards, even with the clock set back a day', async () => {
  const { core, db, clock } = await opened();
  await setSetting(core, 'wakePlan', 400);
  const first = (await db.settings.get('wake_plan'))?.updated_at ?? 0;
  clock.advance(-86_400_000);
  await setSetting(core, 'wakePlan', 410);
  assert.equal((await db.settings.get('wake_plan'))?.updated_at, first + 1);
});

test('unlocking again reads everything back, and finds the last write from the stamps alone', async () => {
  const { core, db, clock } = await opened();
  clock.advance(60_000);
  await setSetting(core, 'cuesOn', false);
  const last = (await db.settings.get('cues_on'))?.updated_at;
  await core.lock();
  const again = openRecord({ db, now: clock.now });                    // the app started afresh
  await again.unlock(cipher());
  assert.deepEqual(again.session?.model.settings, { ...SETTINGS, cuesOn: false });
  assert.equal(again.session?.lastWriteMs, last);
});

test('lock waits for a write already started, then drops everything; a write after it is refused', async () => {
  const { core } = await opened();
  const write = setSetting(core, 'wakePlan', 400);
  const locking = core.lock();
  assert.equal((await write).kind, 'Saved');
  await locking;
  assert.equal(core.session, undefined);
  assert.deepEqual(await setSetting(core, 'wakePlan', 410), { kind: 'Locked' });
});

test('the guard catches a cipher call made inside a write\'s transaction', async () => {
  const { core } = await opened();
  const c = core.session?.cipher ?? cipher();
  await assert.rejects(core.write({
    tables: ['settings'],
    prepare: async () => ({
      puts: [{ table: 'settings', row: { key: 'x', updated_at: 1, updated_by: 'dev' } }],   // an empty write opens no transaction
      check: async () => { await c.seal({ table: 'set', id: 'x', slot: 'r' }, Uint8Array.of(1)); return undefined; },
      apply: () => {},
      value: undefined,
    }),
  }), /inside a storage transaction/);
});

test('the open record gives the rules their notification settings', async () => {
  const { core } = await opened();
  assert.ok(core.session);
  assert.deepEqual(rulesInput(core.session.model).cueSettings, { cuesOn: true, wake: 390, lightsOut: 1350, boundary: 240 });
});
