// Writes backup-v1.fixture.bin: the synthetic v1 backup that every later version of the app must
// still read. Run once, by hand: node tests/record/fixtures/writeBackupFixture.ts. It refuses to
// replace the file, which is checked in and never written again.
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { BODY_TABLES } from '../../../src/record/backup/body.ts';
import { exportBackup } from '../../../src/record/backup/export.ts';
import { filledRecord } from '../helpers.ts';

const path = join(import.meta.dirname, 'backup-v1.fixture.bin');
if (existsSync(path)) throw new Error('backup-v1.fixture.bin exists; the v1 fixture is never written again');
const { core, db } = await filledRecord();
const result = await exportBackup(core, { appVersion: '0.1.0', iv: new Uint8Array(12).fill(7) });
if (result.kind !== 'Saved') throw new Error(`export: ${result.kind}`);
writeFileSync(path, result.value.bytes);
const counts = Object.fromEntries(await Promise.all(BODY_TABLES.map(async t => [t, await db.table(t).count()] as const)));
console.log(`wrote ${result.value.bytes.length} bytes`, counts);
