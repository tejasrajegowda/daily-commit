import type { DevicePort } from '../app/context.ts';
import { browserPort } from './browser.ts';

// Which device the app runs on. Inside the Android app, Capacitor has put its bridge on the page
// before any script runs; anywhere else a browser stands in for the phone. The phone's port is
// loaded only on the phone, so a browser (and every Node test) never loads Capacitor.

export function platformOf(g: { readonly Capacitor?: { getPlatform?(): string } }): 'android' | 'web' {
  return g.Capacitor?.getPlatform?.() === 'android' ? 'android' : 'web';
}

export async function devicePort(
  g: { readonly Capacitor?: { getPlatform?(): string } } = globalThis as { Capacitor?: { getPlatform?(): string } },
  loadAndroid: () => Promise<DevicePort> = () => import('./android.ts').then(m => m.androidPort()),
): Promise<DevicePort> {
  if (platformOf(g) !== 'android') return browserPort();
  return loadAndroid();
}
