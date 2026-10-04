import type { Settings } from '../record/model.ts';
import { firstRun } from '../record/ops/firstRun.ts';
import { vaultRows } from '../record/ops/vault.ts';
import { appDay } from '../record/time.ts';
import type { Result } from '../record/results.ts';
import { enrolMode } from '../vault/devices.ts';
import { MIN_PASSPHRASE_CHARS, passphraseLength } from '../vault/kdf.ts';
import { createVault, type NewVault } from '../vault/keys.ts';
import { readCode } from '../vault/recovery.ts';
import { sessionCiphers } from '../vault/vault.ts';
import { sameBytes } from '../vault/gcm.ts';
import type { AppDeps } from './context.ts';

// The first day, as the app does it. The passphrase is stretched into the keys at step 2, the
// recovery code is shown at step 3, and nothing is written until it has been typed back at step 4.
// Then first run writes everything in one go, the record opens, and where the device can hold one
// the phone-lock copy is made, authorised by the code just typed back.

export { MIN_PASSPHRASE_CHARS };

/** What the screen holds between the steps: only the code to show. The keys stay in here. */
export interface Prepared {
  /** 8 groups of 5 and a check symbol */
  readonly code: string;
}

const made = new WeakMap<Prepared, NewVault>();

export function passphraseLongEnough(text: string): boolean {
  return passphraseLength(text) >= MIN_PASSPHRASE_CHARS;
}

/** Whether a typed code is the shown one: the same 25 bytes once read (case, spaces and dashes don't matter). */
export function sameRecoveryCode(shown: string, typed: string): boolean {
  const a = readCode(shown), b = readCode(typed);
  if (!a.ok || !b.ok) return false;
  const same = sameBytes(a.bytes, b.bytes);
  a.bytes.fill(0);
  b.bytes.fill(0);
  return same;
}

export type PrepareResult = { readonly kind: 'Prepared'; readonly prepared: Prepared } | { readonly kind: 'TooShort' };

/** Makes the keys from the passphrase (the 600,000-round stretch). Nothing is written yet. */
export async function prepareVault(deps: AppDeps, passphrase: string): Promise<PrepareResult> {
  if (!passphraseLongEnough(passphrase)) return { kind: 'TooShort' };
  const vault = await createVault(passphrase, deps.random, deps.core.now());
  const prepared: Prepared = Object.freeze({ code: vault.recoveryCode });
  made.set(prepared, vault);
  return { kind: 'Prepared', prepared };
}

/** The first settings: this device's timezone, the 04:00 boundary, and today as day 1. */
export function firstSettings(now: number, tz: string): Settings {
  const boundary = 240;
  return { tz, boundary, journeyStart: appDay(now, { tz, boundary }), wakePlan: 420, lightsOutPlan: 1380, cuesOn: true };
}

export type FinishResult = Result<void> | { readonly kind: 'CodeMismatch' };

/**
 * Checks the typed-back code, then writes first run and opens the record. A phone-lock copy that
 * can't be made leaves the passphrase as the way in; first run is done all the same.
 */
export async function finishFirstRun(deps: AppDeps, prepared: Prepared, typed: string, settings: Settings): Promise<FinishResult> {
  const vault = made.get(prepared);
  if (!vault) throw new Error('first run: the keys were not prepared here');
  if (!sameRecoveryCode(prepared.code, typed)) return { kind: 'CodeMismatch' };
  const { cipher, backup } = sessionCiphers(vault.keys);
  const result = await firstRun(deps.core, { cipher, backup, vault: vault.vault, wrappers: vault.wrappers, settings });
  if (result.kind !== 'Saved') return result;
  made.delete(prepared);
  await deps.machine.follow();
  deps.store.changed();
  if (deps.device.deviceModes) {
    try {
      const rows = await vaultRows(deps.core);
      if (rows) await enrolMode(rows, { method: 'recovery', text: typed }, deps.device.plugin, 'phone-lock');
    } catch {
      // the phone couldn't make the copy; the passphrase opens it, and Settings can try again
    }
  }
  return result;
}
