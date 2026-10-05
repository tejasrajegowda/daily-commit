import { replaceWrapper, vaultRows } from '../record/ops/vault.ts';
import type { Result } from '../record/results.ts';
import type { Secret } from '../vault/cipher.ts';
import { enrolMode, type EnrolResult } from '../vault/devices.ts';
import type { DeviceMode } from '../vault/plugin.ts';
import { changePassphrase, replaceRecoveryCode, unlockWithSecret, type Unopened } from '../vault/vault.ts';
import type { StoredWrap } from '../vault/stored.ts';
import type { AppDeps } from './context.ts';
import { passphraseLongEnough, sameRecoveryCode } from './firstRunFlow.ts';

// Changing what opens the record, from Settings. Each change is authorised by typing the
// passphrase (or the recovery code) again; the raw key is met only inside the vault's own
// withRawMasterKey. A new recovery code takes over only once it has been typed back, so a change
// left halfway never leaves no working code.

export type SecretOutcome = Result<void> | Unopened | { readonly kind: 'TooShort' } | { readonly kind: 'NoVault' };

async function rows(deps: AppDeps) {
  return vaultRows(deps.core);
}

/** A new passphrase, one generation on; the old one stops opening the record once it is stored. */
export async function newPassphrase(deps: AppDeps, current: Secret, next: string): Promise<SecretOutcome> {
  if (!passphraseLongEnough(next)) return { kind: 'TooShort' };
  const r = await rows(deps);
  if (!r) return { kind: 'NoVault' };
  const made = await changePassphrase(r, current, next, deps.random, deps.core.now());
  if (made.kind !== 'Done') return made;
  return deps.store.run(c => replaceWrapper(c, made.value));
}

/** What the screen holds while a new code waits to be typed back: only the code to show. */
export interface PendingCode {
  readonly code: string;
}
const pending = new WeakMap<PendingCode, StoredWrap>();

/** A new recovery code, made and checked but not stored: the old code still works until it is typed back. */
export async function startNewCode(deps: AppDeps, auth: Secret): Promise<{ readonly kind: 'Pending'; readonly pending: PendingCode } | Unopened | { readonly kind: 'NoVault' }> {
  const r = await rows(deps);
  if (!r) return { kind: 'NoVault' };
  const made = await replaceRecoveryCode(r, auth, deps.random, deps.core.now());
  if (made.kind !== 'Done') return made;
  const shown: PendingCode = Object.freeze({ code: made.value.code });
  pending.set(shown, made.value.wrap);
  return { kind: 'Pending', pending: shown };
}

/** The new code typed back; only then is it stored, and the old code stops opening the record. */
export async function finishNewCode(deps: AppDeps, shown: PendingCode, typed: string): Promise<Result<void> | { readonly kind: 'CodeMismatch' }> {
  const wrap = pending.get(shown);
  if (!wrap) throw new Error('a new code was not started here');
  if (!sameRecoveryCode(shown.code, typed)) return { kind: 'CodeMismatch' };
  const result = await deps.store.run(c => replaceWrapper(c, wrap));
  if (result.kind === 'Saved') pending.delete(shown);
  return result;
}

/** Whether the code on paper opens this record. Nothing changes. */
export async function checkCode(deps: AppDeps, typed: string): Promise<boolean> {
  const r = await rows(deps);
  if (!r) return false;
  return (await unlockWithSecret(r, { method: 'recovery', text: typed })).kind === 'Unlocked';
}

/** Sets up a way of opening on this device: the phone's lock, an own code, or the fingerprint inside own-code mode. */
export async function setMode(deps: AppDeps, auth: Secret, mode: DeviceMode, code?: string): Promise<EnrolResult | { readonly kind: 'NoVault' }> {
  const r = await rows(deps);
  if (!r) return { kind: 'NoVault' };
  return enrolMode(r, auth, deps.device.plugin, mode, code);
}

/** Switches the fingerprint off inside own-code mode; the code still opens it. */
export async function fingerprintOff(deps: AppDeps): Promise<void> {
  await deps.device.plugin.remove('fingerprint');
}
