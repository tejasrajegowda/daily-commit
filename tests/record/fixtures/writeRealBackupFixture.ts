// Writes backup-v1-real.fixture.bin: the same invented record as backup-v1.fixture.bin, sealed by
// the real cipher under the golden vault, so every later version of the app must still open a real
// v1 file. Run once, by hand: node tests/record/fixtures/writeRealBackupFixture.ts. It refuses to
// replace the file, which is checked in and never written again.
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { BODY_TABLES } from '../../../src/record/backup/body.ts';
import { exportBackup } from '../../../src/record/backup/export.ts';
import { openRecord } from '../../../src/record/core.ts';
import { firstRun } from '../../../src/record/ops/firstRun.ts';
import { sessionCiphers } from '../../../src/vault/vault.ts';
import { goldenVault } from '../../vault/helpers.ts';
import { fillRecord, freshDb } from '../helpers.ts';
import { SETTINGS, testClock } from '../fixtures.ts';

const path = join(import.meta.dirname, 'backup-v1-real.fixture.bin');
if (existsSync(path)) throw new Error('backup-v1-real.fixture.bin exists; the v1 fixture is never written again');
const made = await goldenVault();
const db = freshDb();
const clock = testClock('2026-01-05T09:00:00Z');
const core = openRecord({ db, now: clock.now });
const { cipher, backup } = sessionCiphers(made.keys);
const setup = await firstRun(core, { cipher, backup, vault: made.vault, wrappers: made.wrappers, settings: SETTINGS });
if (setup.kind !== 'Saved') throw new Error(`first run: ${setup.kind}`);
await fillRecord(core, clock);
const result = await exportBackup(core, { appVersion: '0.1.0', iv: new Uint8Array(12).fill(7) });
if (result.kind !== 'Saved') throw new Error(`export: ${result.kind}`);
writeFileSync(path, result.value.bytes);
const counts = Object.fromEntries(await Promise.all(BODY_TABLES.map(async t => [t, await db.table(t).count()] as const)));
console.log(`wrote ${result.value.bytes.length} bytes`, counts);
