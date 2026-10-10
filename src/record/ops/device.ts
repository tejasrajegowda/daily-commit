import type { RecordDb } from '../db.ts';

// This device's own plain values, such as how bright the app is drawn. They are needed before
// unlock, belong to this device only, and are never exported or carried by a backup.

/** How the app is drawn on this device. */
export interface Display {
  /** contrast, 0.6 to 1.6; 1 is the design's own */
  readonly contrast: number;
  /** after 19:00 the whole app runs 15% dimmer */
  readonly dim: boolean;
}

export const DISPLAY_DEFAULT: Display = { contrast: 1, dim: false };

const clampContrast = (k: number) => Math.min(1.6, Math.max(0.6, Math.round(k * 100) / 100));

export async function readDisplay(db: RecordDb): Promise<Display> {
  const [k, dim] = await Promise.all([db.device.get('contrast'), db.device.get('dim')]);
  return {
    contrast: typeof k?.value === 'number' ? clampContrast(k.value) : DISPLAY_DEFAULT.contrast,
    dim: typeof dim?.value === 'boolean' ? dim.value : DISPLAY_DEFAULT.dim,
  };
}

export async function writeDisplay(db: RecordDb, display: Display): Promise<void> {
  await db.device.bulkPut([{ key: 'contrast', value: clampContrast(display.contrast) }, { key: 'dim', value: display.dim }]);
}

/** A system screen the app opened and was waiting on when the process last ended (R-3): the kind only. */
export type HandOffKind = 'export' | 'restore' | 'fingerprint';
const HAND_OFFS: readonly HandOffKind[] = ['export', 'restore', 'fingerprint'];

export async function readHandOff(db: RecordDb): Promise<HandOffKind | undefined> {
  const v = (await db.device.get('handoff'))?.value;
  return HAND_OFFS.find(k => k === v);
}

/** `undefined` removes the mark. */
export async function writeHandOff(db: RecordDb, kind: HandOffKind | undefined): Promise<void> {
  if (kind === undefined) await db.device.delete('handoff');
  else await db.device.put({ key: 'handoff', value: kind });
}

/** Whether the phone agreed to keep the app's storage from clean-up, as it last answered (C11). */
export async function readPersisted(db: RecordDb): Promise<boolean | undefined> {
  const v = (await db.device.get('persisted'))?.value;
  return typeof v === 'boolean' ? v : undefined;
}

export async function writePersisted(db: RecordDb, kept: boolean): Promise<void> {
  await db.device.put({ key: 'persisted', value: kept });
}
