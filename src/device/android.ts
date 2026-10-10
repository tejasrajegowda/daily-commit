import { App } from '@capacitor/app';
import { registerPlugin } from '@capacitor/core';
import type { DevicePort } from '../app/context.ts';
import { androidPortWith, type ShellBridge, type VaultBridge } from './androidPort.ts';

// The phone's port with the real plugins. Loaded only inside the Android app (device/index.ts).

export function androidPort(): DevicePort {
  return androidPortWith({ vault: registerPlugin<VaultBridge>('Vault'), shell: registerPlugin<ShellBridge>('Shell'), app: App });
}
