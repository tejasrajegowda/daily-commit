// A backup whose words and record keys name another key than its own vault (review R2-1). The body
// and every wrap are genuine, so only a file built on purpose can look like this; it must still be
// refused before anything is written, whether or not it holds a locked value.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dkAad } from '../../src/vault/aad.ts';
import { backupCipher } from '../../src/vault/backupCipher.ts';
import { toBase64url } from '../../src/vault/encoding.ts';
import { gcmSeal, importAesKey } from '../../src/vault/gcm.ts';
import { createVault, importMaster, openDataKeys, unwrapMaster } from '../../src/vault/keys.ts';
import { systemRandom } from '../../src/vault/random.ts';
import { rowCipher } from '../../src/vault/rowCipher.ts';
import type { StoredVault, StoredWrap } from '../../src/vault/stored.ts';
import { TABLE_TAGS } from '../../src/vault/tags.ts';
import { bodyJson, gzip, type StoredRows } from '../../src/record/backup/body.ts';
import { FORMAT, FORMAT_VERSION, frame, headerBytes } from '../../src/record/backup/format.ts';
import { restore } from '../../src/record/backup/restore.ts';
import { openRecord } from '../../src/record/core.ts';
import { SCHEMA_VERSION } from '../../src/record/db.ts';
import { freshDb } from '../record/helpers.ts';

const PASS = 'CANARY passphrase';
const NOW = 1_767_603_600_000;

const tablesOf = (vault: StoredVault): StoredRows => ({
  vault: [vault], settings: [], habits: [], observations: [], days: [], entries: [], notyet: [], cues: [], reviews: [],
});

async function fileOf(vault: StoredVault, wrappers: readonly [StoredWrap, StoredWrap], backupKey: CryptoKey, tables: StoredRows): Promise<Uint8Array> {
  const iv = systemRandom(12);
  const head = headerBytes({
    format: FORMAT, format_version: FORMAT_VERSION, schema_version: SCHEMA_VERSION, app_version: '0.1.0',
    exported_at: NOW, vault_id: vault.vault_id, kid: vault.kid, generation: vault.generation, iv: toBase64url(iv),
    wrappers: { passphrase: wrappers[0], recovery: wrappers[1] },
  });
  return frame(head, await backupCipher({ backup: backupKey }).sealBody(await gzip(bodyJson(tables)), head, iv));
}

/** Restores into an empty record; returns the outcome and how many vault rows were written. */
async function restoreInto(file: Uint8Array) {
  const db = freshDb();
  const result = await restore(openRecord({ db, now: () => NOW }), { file, secret: { method: 'passphrase', text: PASS }, backupCipher: backupCipher() });
  return { result, vaults: await db.table('vault').count() };
}

test('R2-1: data keys naming another key than the vault are refused as damaged, with a locked value or none, and nothing is written', async () => {
  const made = await createVault(PASS, systemRandom, NOW);
  const raw = await unwrapMaster(made.wrappers[0], { passphrase: PASS });
  const otherKid = toBase64url(systemRandom(16));
  const sealer = await importAesKey(raw.slice(), ['encrypt']);
  const wrapUnder = async (kid: string) => {
    const id = toBase64url(systemRandom(16));
    const iv = systemRandom(12);
    const ct = await gcmSeal(sealer, iv, dkAad(1, id, kid), systemRandom(32));
    return { id, wrap: { v: 1, k: kid, iv: toBase64url(iv), ct: toBase64url(ct) } };
  };
  const keys = { w: await wrapUnder(otherKid), r: await wrapUnder(otherKid) };
  const { master } = await importMaster(raw);
  const env = await rowCipher(await openDataKeys(master, { kid: otherKid, keys })).seal(
    { table: TABLE_TAGS.observations, id: 'habit-canary|2026-01-05', slot: 'r' },
    new TextEncoder().encode('{"pv":1,"kind":"yes"}'),
  );
  const crafted = { ...made.vault, keys };
  const withValue: StoredRows = {
    ...tablesOf(crafted),
    observations: [{ habit_id: 'habit-canary', local_date: '2026-01-05', updated_at: NOW, updated_by: 'device-canary', r: env }],
  };

  for (const tables of [withValue, tablesOf(crafted)]) {
    const { result, vaults } = await restoreInto(await fileOf(crafted, made.wrappers, made.keys.backup, tables));
    assert.deepEqual(result, { kind: 'Refused', reason: 'damaged' });
    assert.equal(vaults, 0);
  }
  const honest = await restoreInto(await fileOf(made.vault, made.wrappers, made.keys.backup, tablesOf(made.vault)));
  assert.equal(honest.result.kind, 'Restored');
  assert.equal(honest.vaults, 1);
});
