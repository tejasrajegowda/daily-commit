import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_SHAPES } from '../../src/app/dayShapes.ts';
import { setSetting } from '../../src/record/ops/settings.ts';
import { openSession } from '../../src/record/ops/session.ts';
import { sessionCiphers, unlockWithSecret } from '../../src/vault/vault.ts';
import { PASSPHRASE, realRecord, rowsOf } from '../app/realRecord.ts';

test('the day shapes and pause are kept, locked, and come back after a lock', async () => {
  const { core } = await realRecord();
  assert.equal((await setSetting(core, 'dayShapes', DEFAULT_SHAPES)).kind, 'Saved');
  assert.equal((await setSetting(core, 'paused', true)).kind, 'Saved');
  await core.lock();
  const opened = await unlockWithSecret(await rowsOf(core), { method: 'passphrase', text: PASSPHRASE });
  assert.equal(opened.kind, 'Unlocked');
  if (opened.kind !== 'Unlocked') return;
  const { cipher, backup } = sessionCiphers(opened.keys);
  await openSession(core, cipher, backup);
  assert.deepEqual(core.session?.model.settings.dayShapes, DEFAULT_SHAPES);
  assert.equal(core.session?.model.settings.paused, true);
});

test('a block outside its window, steps out of order, or a pause that is not on or off are refused', async () => {
  const { core } = await realRecord();
  const outside = { ...DEFAULT_SHAPES, weekday: { ...DEFAULT_SHAPES.weekday, blocks: [{ start: 200, end: 400, label: 'Early' }] } };
  assert.equal((await setSetting(core, 'dayShapes', outside)).kind, 'Invalid');
  const backwards = { ...DEFAULT_SHAPES, weekend: { ...DEFAULT_SHAPES.weekend, steps: [{ at: 600, label: 'B' }, { at: 400, label: 'A' }] } };
  assert.equal((await setSetting(core, 'dayShapes', backwards)).kind, 'Invalid');
  assert.equal((await setSetting(core, 'paused', 'yes' as unknown as boolean)).kind, 'Invalid');
});

test('while tracking is paused the reminder schedule is empty, whatever the reminders switch says', async () => {
  const { cueSettingsOf } = await import('../../src/record/mapping.ts');
  const base = { tz: 'UTC', boundary: 240, journeyStart: '2026-01-05', wakePlan: 420, lightsOutPlan: 1380, cuesOn: true };
  assert.equal(cueSettingsOf(base).cuesOn, true);
  assert.equal(cueSettingsOf({ ...base, paused: true }).cuesOn, false);
});
