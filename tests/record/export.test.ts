import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { RowCipher, Secret } from '../../src/vault/cipher.ts';
import type { RecordCore } from '../../src/record/core.ts';
import { toBase64url } from '../../src/record/bytes.ts';
import { readFrame } from '../../src/record/backup/format.ts';
import { BODY_TABLES, gunzip, parseBody } from '../../src/record/backup/body.ts';
import { exportBackup, type BackupOptions } from '../../src/record/backup/export.ts';
import { filledRecord } from './helpers.ts';
import { VAULT } from './fixtures.ts';
import { STUB_SECRETS, stubBackup } from './stubBackup.ts';
import { stubCipher } from './stubCipher.ts';
import { guarded, guardedBackup } from './txGuard.ts';

const OPTS: BackupOptions = { appVersion: '0.1.0', iv: new Uint8Array(12).fill(7) };
const PASS: Secret = { method: 'passphrase', text: STUB_SECRETS.passphrase };

async function exported(core: RecordCore, options: BackupOptions = OPTS) {
  const result = await exportBackup(core, options);
  if (result.kind !== 'Saved') throw new Error(result.kind);
  return result.value;
}

async function openFile(bytes: Uint8Array, secret: Secret = PASS) {
  const f = readFrame(bytes);
  const opened = await stubBackup().openBody(f.headerBytes, f.iv, f.ct, f.header.wrappers, secret);
  return { ...f, tables: parseBody(await gunzip(opened.body)) };
}

test('export needs the record unlocked', async () => {
  const { core } = await filledRecord();
  await core.lock();
  assert.deepEqual(await exportBackup(core, OPTS), { kind: 'Locked' });
});

test('the header holds the vault, both wrappers as stored, the time and the IV, in the fixed key order', async () => {
  const { core, db } = await filledRecord();
  const { bytes, name } = await exported(core);
  const { header } = readFrame(bytes);
  assert.deepEqual(Object.keys(header), ['format', 'format_version', 'schema_version', 'app_version', 'exported_at', 'vault_id', 'kid', 'generation', 'iv', 'wrappers']);
  assert.deepEqual(
    { format: header.format, format_version: header.format_version, schema_version: header.schema_version, app_version: header.app_version, vault_id: header.vault_id, kid: header.kid, generation: header.generation, iv: header.iv },
    { format: 'daily-commit-backup', format_version: 1, schema_version: 1, app_version: '0.1.0', vault_id: VAULT.vault_id, kid: VAULT.kid, generation: 1, iv: toBase64url(new Uint8Array(12).fill(7)) },
  );
  assert.deepEqual(header.wrappers, { passphrase: await db.wrappers.get('passphrase'), recovery: await db.wrappers.get('recovery') });
  assert.equal(header.exported_at, core.session?.lastWriteMs);     // the change-stamp scale: never behind the newest row
  assert.equal(name, 'backup-2026-01-06.dcbak');
});

test('the body holds every table but device, migrations and wrappers: rows exactly as stored, in key order, tombstones too', async () => {
  const { core, db } = await filledRecord();
  const { tables } = await openFile((await exported(core)).bytes);
  assert.deepEqual(Object.keys(tables), [...BODY_TABLES]);
  for (const t of BODY_TABLES) assert.deepEqual(tables[t], await db.table(t).toArray(), t);
  const [cue] = tables.cues as readonly Record<string, unknown>[];
  assert.ok(cue && cue.deleted_at !== undefined && cue.r === undefined && cue.w === undefined, 'a deleted reminder travels as a tombstone');
  assert.equal(tables.observations.length, 2);
});

test('export copies rows as stored: no row is opened, and the same record, time and IV give the same bytes', async () => {
  const { core } = await filledRecord();
  await core.lock();
  let calls = 0;
  const rows = guarded(stubCipher());
  const counting: RowCipher = {
    seal: (ctx, plain) => { calls++; return rows.seal(ctx, plain); },
    open: (ctx, env) => { calls++; return rows.open(ctx, env); },
  };
  await core.unlock(counting, guardedBackup(stubBackup()));
  calls = 0;
  const a = await exported(core), b = await exported(core);
  assert.equal(calls, 0);
  assert.deepEqual(a.bytes, b.bytes);
  assert.notDeepEqual((await exported(core, { ...OPTS, iv: new Uint8Array(12).fill(8) })).bytes, a.bytes);
});

test('the file opens with the passphrase and with the recovery code, and with nothing else', async () => {
  const { core } = await filledRecord();
  const { bytes } = await exported(core);
  const byPass = await openFile(bytes, PASS);
  const byCode = await openFile(bytes, { method: 'recovery', text: STUB_SECRETS.recovery });
  assert.deepEqual(byPass.tables, byCode.tables);
  await assert.rejects(openFile(bytes, { method: 'passphrase', text: 'CANARY-WRONG' }), { reason: 'wrong-secret' });
});

test('a changed byte in the header or in the body is caught', async () => {
  const { core } = await filledRecord();
  const { bytes } = await exported(core);
  const inHeader = bytes.slice();
  inHeader[Buffer.from(bytes).indexOf('"0.1.0"') + 1] = 0x39;          // app_version 9.1.0: still a valid header
  await assert.rejects(openFile(inHeader), { reason: 'damaged' });
  const inBody = bytes.slice();
  const at = inBody.length - 20;
  inBody[at] = (inBody[at] ?? 0) ^ 1;
  await assert.rejects(openFile(inBody), { reason: 'damaged' });
});
