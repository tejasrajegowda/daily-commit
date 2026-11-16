import type { DeviceMode } from '../app/context.ts';

// Which lock layout to draw. It comes only from the device copies that exist, never from a setting.

export type LockLayout = 'passphrase' | 'phone' | 'code';

/**
 * The passphrase when nothing is offered; the code pad when a code exists; else the phone's lock. Never from the
 * screen's width: a tablet is wide and is still the phone app (D-38), and a browser offers nothing anyway.
 */
export function lockLayout(offered: readonly DeviceMode[]): LockLayout {
  if (offered.length === 0) return 'passphrase';
  if (offered.includes('own-code')) return 'code';
  return offered.includes('phone-lock') ? 'phone' : 'passphrase';
}

/** The code pad's fingerprint key: only while the fingerprint's copy exists. */
export function fingerprintKey(offered: readonly DeviceMode[]): boolean {
  return offered.includes('fingerprint');
}

/** Past this, an unlock still under way shows "Opening…" (U3 Task 11). */
export const SLOW_MS = 2000;
export const OPENING_WORDS = { title: 'Opening…', hint: 'It can take a few seconds.' } as const;
