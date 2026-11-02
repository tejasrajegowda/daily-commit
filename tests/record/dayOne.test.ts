import { test } from 'node:test';
import assert from 'node:assert/strict';
import { firstSettings } from '../../src/app/firstRunFlow.ts';
import { openRecord } from '../../src/record/core.ts';
import { exportBackup } from '../../src/record/backup/export.ts';
import { restore } from '../../src/record/backup/restore.ts';
import { setSetting } from '../../src/record/ops/settings.ts';
import { filledRecord, freshDb } from './helpers.ts';
import { testClock } from './fixtures.ts';
import { STUB_SECRETS, stubBackup } from './stubBackup.ts';
import { stubCipher } from './stubCipher.ts';
import { guarded, guardedBackup } from './txGuard.ts';
import { realRecord } from '../app/realRecord.ts';

test('Day 1 is first run\'s app-day, before and after the 04:00 boundary', () => {
  assert.equal(firstSettings(Date.UTC(2026, 0, 5, 9), 'UTC').journeyStart, '2026-01-05');
  assert.equal(firstSettings(Date.UTC(2026, 0, 5, 2), 'UTC').journeyStart, '2026-01-04');
});

test('RF3: Day 1 never moves once the record exists, earlier or later, and nothing is written', async () => {
  const { db, core } = await realRecord();
  const before = await db.settings.toArray();
  for (const day of ['2025-12-01', '2026-02-01', '2026-01-05']) {
    const result = await setSetting(core, 'journeyStart', day);
    assert.equal(result.kind, 'Invalid');
    assert.match(result.kind === 'Invalid' ? result.reason : '', /Day 1 never moves/);
  }
  assert.equal(core.session?.model.settings.journeyStart, '2026-01-05');
  assert.deepEqual(await db.settings.toArray(), before);
});

test('a restore keeps the backup\'s Day 1', async () => {
  const a = await filledRecord();
  const exported = await exportBackup(a.core, { appVersion: '0.1.0', iv: new Uint8Array(12).fill(7) });
  if (exported.kind !== 'Saved') throw new Error(exported.kind);
  const b = openRecord({ db: freshDb(), now: testClock('2026-03-01T20:00:00Z').now });
  const restored = await restore(b, { file: exported.value.bytes, secret: { method: 'passphrase', text: STUB_SECRETS.passphrase }, backupCipher: guardedBackup(stubBackup()) });
  assert.deepEqual(restored, { kind: 'Restored' });
  await b.unlock(guarded(stubCipher()));
  assert.equal(b.session?.model.settings.journeyStart, '2026-01-05');
});
