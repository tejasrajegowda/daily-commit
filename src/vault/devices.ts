import { CipherError, type Secret } from './cipher.ts';
import { fromBase64url, toBase64url } from './encoding.ts';
import { sameBytes, KEY_BYTES } from './gcm.ts';
import { openKeys, type OpenKeys } from './keys.ts';
import type { DeviceMode, VaultPlugin } from './plugin.ts';
import { withRawMasterKey, type Unopened, type VaultRowsIn } from './vault.ts';

// Opening the vault through the phone, and changing how. A new mode is made from the master key
// (after the passphrase or recovery code is typed again), opened back and compared, and only then
// is the previous mode's copy deleted. Any device copy that doesn't open this vault's W and R,
// for example one left from before a restore, is deleted, and the passphrase is asked for.

/** The fewest digits an own code may have. */
export const MIN_CODE_DIGITS = 6;

/** The unlock choices on offer: whatever device copies exist, never a setting. */
export async function offeredModes(plugin: VaultPlugin): Promise<readonly DeviceMode[]> {
  return (await plugin.status()).modes;
}

/** The modes that may stay beside a newly enrolled one: a fingerprint lives inside own-code mode. */
function keepsBeside(mode: DeviceMode, other: DeviceMode): boolean {
  if (mode === 'phone-lock') return false;
  return other !== 'phone-lock';
}

export type EnrolResult =
  | { readonly kind: 'Enrolled' }
  | Unopened
  /** an own code must be at least six digits, and only digits */
  | { readonly kind: 'CodeTooShort' }
  /** a fingerprint can be added only within own-code mode */
  | { readonly kind: 'NeedsOwnCode' }
  /** the new copy didn't open back to the same key; it was deleted, and nothing else changed */
  | { readonly kind: 'NotVerified' };

const codeOk = (code: string | undefined): code is string => code !== undefined && new RegExp(`^[0-9]{${MIN_CODE_DIGITS},}$`).test(code);

/**
 * Makes the device copy for a mode, verifies it opens to the master key, then deletes the copies
 * the mode replaces. Own-code mode needs the code; changing the code is enrolling it again.
 */
export async function enrolMode(rows: VaultRowsIn, auth: Secret, plugin: VaultPlugin, mode: DeviceMode, code?: string): Promise<EnrolResult> {
  if (mode === 'own-code' && !codeOk(code)) return { kind: 'CodeTooShort' };
  const before = await offeredModes(plugin);
  if (mode === 'fingerprint' && !before.includes('own-code')) return { kind: 'NeedsOwnCode' };
  const done = await withRawMasterKey(rows, auth, async (raw): Promise<EnrolResult> => {
    await plugin.enrol(mode, toBase64url(raw), mode === 'own-code' ? code : undefined);
    const back = mode === 'own-code' ? await plugin.verifyCode(code ?? '') : await plugin.unwrap(mode);
    let same = false;
    if (back.kind === 'Key') {
      const bytes = fromBase64url(back.masterKey);
      same = sameBytes(bytes, raw);
      bytes.fill(0);
    }
    if (!same) {
      await plugin.remove(mode);
      return { kind: 'NotVerified' };
    }
    for (const other of before) if (other !== mode && !keepsBeside(mode, other)) await plugin.remove(other);
    return { kind: 'Enrolled' };
  });
  return done.kind === 'Done' ? done.value : done;
}

export type DeviceUnlock =
  | { readonly kind: 'Unlocked'; readonly keys: OpenKeys }
  | { readonly kind: 'Cancelled' }
  | { readonly kind: 'WrongCode'; readonly triesLeft: number }
  /** the copy is gone; these are the choices left (none: use the passphrase) */
  | { readonly kind: 'CopyGone'; readonly offered: readonly DeviceMode[] };

export type DeviceAuth = { readonly mode: 'phone-lock' | 'fingerprint' } | { readonly mode: 'own-code'; readonly code: string };

/** Deletes every device copy: after a restore, and whenever one is found opening the wrong vault. */
export async function forgetDevice(plugin: VaultPlugin): Promise<void> {
  for (const mode of await offeredModes(plugin)) await plugin.remove(mode);
}

/** Opens the vault with a device copy. */
export async function unlockWithDevice(rows: VaultRowsIn, plugin: VaultPlugin, auth: DeviceAuth): Promise<DeviceUnlock> {
  const back = auth.mode === 'own-code' ? await plugin.verifyCode(auth.code) : await plugin.unwrap(auth.mode);
  if (back.kind === 'Cancelled') return back;
  if (back.kind === 'WrongCode' && back.triesLeft > 0) return back;
  if (back.kind !== 'Key') {
    await plugin.remove(auth.mode);
    return { kind: 'CopyGone', offered: await offeredModes(plugin) };
  }
  // a copy that can't open this vault's W and R counts as missing, and so does every copy made beside it
  const gone = async (): Promise<DeviceUnlock> => {
    await forgetDevice(plugin);
    return { kind: 'CopyGone', offered: [] };
  };
  const raw = masterBytes(back.masterKey);
  if (!raw) return gone();
  try {
    return { kind: 'Unlocked', keys: await openKeys(raw, rows.vault) };
  } catch (e) {
    if (e instanceof CipherError) return gone();
    throw e;
  }
}

/** A master key handed back as text, or undefined if it isn't 32 bytes of base64url. */
function masterBytes(text: string): Uint8Array<ArrayBuffer> | undefined {
  try {
    const bytes = fromBase64url(text);
    if (bytes.length === KEY_BYTES) return bytes;
    bytes.fill(0);
  } catch {
    // not base64url: treated as no key at all
  }
  return undefined;
}
