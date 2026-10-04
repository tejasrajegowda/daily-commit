// A record set up through first run with a real vault, for the app's tests. Invented secrets only.
import { openRecord, type RecordCore } from '../../src/record/core.ts';
import type { RecordDb } from '../../src/record/db.ts';
import { firstRun } from '../../src/record/ops/firstRun.ts';
import { vaultRows, type VaultRows } from '../../src/record/ops/vault.ts';
import { createVault } from '../../src/vault/keys.ts';
import { systemRandom } from '../../src/vault/random.ts';
import { sessionCiphers } from '../../src/vault/vault.ts';
import { freshDb } from '../record/helpers.ts';
import { guarded, guardedBackup } from '../record/txGuard.ts';
import { SETTINGS, testClock } from '../record/fixtures.ts';

export const PASSPHRASE = 'CANARY passphrase';

/** First run with a real vault on a fresh database; the record is open, its clock on 2026-01-05 09:00 (UTC). */
export async function realRecord(passphrase = PASSPHRASE, db: RecordDb = freshDb()) {
  const clock = testClock('2026-01-05T09:00:00Z');
  const core = openRecord({ db, now: clock.now });
  const made = await createVault(passphrase, systemRandom, clock.now());
  const { cipher, backup } = sessionCiphers(made.keys);
  const result = await firstRun(core, { cipher: guarded(cipher), backup: guardedBackup(backup), vault: made.vault, wrappers: made.wrappers, settings: SETTINGS });
  if (result.kind !== 'Saved') throw new Error(`first run: ${result.kind}`);
  return { db, clock, core, code: made.recoveryCode };
}

/** The vault's plain rows; the record must have finished first run. */
export async function rowsOf(core: RecordCore): Promise<VaultRows> {
  const rows = await vaultRows(core);
  if (!rows) throw new Error('no vault');
  return rows;
}
