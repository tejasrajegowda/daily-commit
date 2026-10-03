// The door to the phone's own key store: the native `vault` plugin. The phone keeps device-bound
// copies of the master key, each under a key that never leaves its security chip, in a file that
// is never backed up. This is only the shape of the door; the phone's side is native code.

/** How the phone can open the vault without the passphrase. */
export type DeviceMode = 'phone-lock' | 'own-code' | 'fingerprint';

export interface PluginStatus {
  /** the device copies that exist now; the unlock choices on offer come only from this */
  readonly modes: readonly DeviceMode[];
}

/** What a device copy gave back. The master key crosses as base64url text, for a moment. */
export type NativeOpen =
  | { readonly kind: 'Key'; readonly masterKey: string }
  /** the person backed out of the phone's prompt */
  | { readonly kind: 'Cancelled' }
  /** the copy is gone, or its key was invalidated (a new fingerprint was enrolled) */
  | { readonly kind: 'Missing' };

export type CodeCheck =
  | { readonly kind: 'Key'; readonly masterKey: string }
  /** the counter is written before each try; after the fifth wrong code the code and fingerprint copies are deleted */
  | { readonly kind: 'WrongCode'; readonly triesLeft: number }
  | { readonly kind: 'Missing' };

export interface VaultPlugin {
  status(): Promise<PluginStatus>;
  /** makes the device copy for a mode; own-code mode needs the code to compute its key */
  enrol(mode: DeviceMode, masterKey: string, code?: string): Promise<void>;
  /** opens a copy, after the phone's own prompt */
  unwrap(mode: 'phone-lock' | 'fingerprint'): Promise<NativeOpen>;
  /** checks the own code and opens its copy; never returns anything the code was stretched into */
  verifyCode(code: string): Promise<CodeCheck>;
  /** deletes a mode's copy and its key; removing a mode that isn't there does nothing */
  remove(mode: DeviceMode): Promise<void>;
}
