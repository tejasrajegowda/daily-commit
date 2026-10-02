// Invented keys and settings for record tests. Nothing here is real.
import type { Settings } from '../../src/record/model.ts';
import type { VaultRow, WrapperRow } from '../../src/record/rows.ts';
import { STUB_KEYS } from './stubCipher.ts';

export const SETTINGS: Settings = { tz: 'UTC', boundary: 240, journeyStart: '2026-01-05', wakePlan: 390, lightsOutPlan: 1350, cuesOn: true };

const MADE = Date.UTC(2026, 0, 5, 9);
const KID = 'fixture-master-kid';
const WRAP = { v: 1, k: KID, iv: 'fixture-iv', ct: 'fixture-wrapped-key' };

export const VAULT: VaultRow = {
  key: 'main', vault_id: 'fixture-vault-id', kid: KID, generation: 1,
  keys: { w: { id: STUB_KEYS.w, wrap: WRAP }, r: { id: STUB_KEYS.r, wrap: WRAP } },
  created_at: MADE, updated_at: MADE,
};

export const WRAPPERS: readonly WrapperRow[] = [
  { method: 'passphrase', kid: KID, generation: 1, kdf: { alg: 'pbkdf2-sha256', iterations: 600_000, salt: 'fixture-salt-1', norm: 'utf8-nfc-trim-v1' }, iv: 'fixture-iv', ct: 'fixture-ct-1', created_at: MADE, updated_at: MADE },
  { method: 'recovery', kid: KID, generation: 1, kdf: { alg: 'hkdf-sha256', salt: 'fixture-salt-2', info: 'dc/recovery/v1' }, iv: 'fixture-iv', ct: 'fixture-ct-2', created_at: MADE, updated_at: MADE },
];

/** A clock the test moves by hand. */
export function testClock(iso: string) {
  let t = Date.parse(iso);
  return {
    now: () => t,
    set: (next: string) => { t = Date.parse(next); },
    advance: (ms: number) => { t += ms; },
  };
}
