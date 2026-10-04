import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { TABLE_TAGS } from '../../src/vault/tags.ts';
import type { SettingRow, VaultRow } from '../../src/record/rows.ts';
import { frame, readFrame } from '../../src/record/backup/format.ts';
import { BODY_TABLES, gunzip, parseBody } from '../../src/record/backup/body.ts';
import { VAULT } from './fixtures.ts';
import { STUB_SECRETS, stubBackup } from './stubBackup.ts';

const FILE = join(import.meta.dirname, 'fixtures', 'backup-v1.fixture.bin');

test('the checked-in v1 backup still reads: its frame, its header, both secrets, every table', async () => {
  const bytes = new Uint8Array(readFileSync(FILE));
  const f = readFrame(bytes);
  assert.deepEqual(frame(f.headerBytes, f.ct), bytes);                 // the layout, to the byte
  assert.deepEqual([f.header.format_version, f.header.schema_version, f.header.vault_id], [1, 1, VAULT.vault_id]);
  const backup = stubBackup();
  const byPass = await backup.openBody(f.headerBytes, f.iv, f.ct, f.header.wrappers, { method: 'passphrase', text: STUB_SECRETS.passphrase });
  const byCode = await backup.openBody(f.headerBytes, f.iv, f.ct, f.header.wrappers, { method: 'recovery', text: STUB_SECRETS.recovery });
  assert.deepEqual(byPass.body, byCode.body);
  const tables = parseBody(await gunzip(byPass.body));
  assert.deepEqual(
    Object.fromEntries(BODY_TABLES.map(t => [t, tables[t].length])),
    { vault: 1, settings: 6, habits: 1, observations: 2, days: 0, entries: 1, notyet: 1, cues: 1, reviews: 1 },
  );
  const vault = tables.vault[0] as VaultRow;
  for (const row of tables.settings as readonly SettingRow[]) {
    if (row.r) await byPass.testOpen(vault, { table: TABLE_TAGS.settings, id: row.key, slot: 'r' }, row.r);
  }
});
