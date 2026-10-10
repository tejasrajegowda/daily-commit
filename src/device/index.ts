import type { DevicePort } from '../app/context.ts';
import { browserPort } from './browser.ts';

// Which device the app runs on. Inside the Android app, Capacitor has put its bridge on the page
// before any script runs; anywhere else a browser stands in for the phone. The phone's port is
// loaded only on the phone, so a browser (and every Node test) never loads Capacitor.

export function platformOf(g: { readonly Capacitor?: { getPlatform?(): string } }): 'android' | 'web' {
  return g.Capacitor?.getPlatform?.() === 'android' ? 'android' : 'web';
}

export async function devicePort(): Promise<DevicePort> {
  if (platformOf(globalThis as { Capacitor?: { getPlatform?(): string } }) !== 'android') return browserPort();
  const { androidPort } = await import('./android.ts');
  return androidPort();
}
