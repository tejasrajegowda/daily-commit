import type { DeviceMode } from '../app/context.ts';

// Which lock layout to draw. It comes only from the device copies that exist, never from a setting.

export type LockLayout = 'passphrase' | 'phone' | 'code';

/** The passphrase when nothing is offered or on a wide screen; the code pad when a code exists; else the phone's lock. */
export function lockLayout(offered: readonly DeviceMode[], wide: boolean): LockLayout {
  if (wide || offered.length === 0) return 'passphrase';
  if (offered.includes('own-code')) return 'code';
  return offered.includes('phone-lock') ? 'phone' : 'passphrase';
}

/** The code pad's fingerprint key: only while the fingerprint's copy exists. */
export function fingerprintKey(offered: readonly DeviceMode[]): boolean {
  return offered.includes('fingerprint');
}
