import { eventRows } from '../changes.ts';
import { EVENTS_LOGGED_TO, type Put, type RecordCore } from '../core.ts';
import type { RecordDb } from '../db.ts';

// Usage events (D-26): the app was opened, a reminder was shown, a reminder was tapped. Each is one sealed
// line in the change log, with a random id and no plain time, never shown or counted on any screen
// (§8 #28). They are written in their own quiet write after unlock, so they never hold up opening the app
// and never count as a change to the record; a write that fails is simply not recorded.

export { EVENTS_LOGGED_TO };

export type UsageEvent =
  | { readonly type: 'opened' }
  | { readonly type: 'reminder-tapped'; readonly due: number }
  | { readonly type: 'reminder-shown'; readonly due: number; readonly in_tray?: boolean };

/** How far the reminders shown are already logged (a due time), or undefined before the first time. */
export async function readLoggedTo(db: RecordDb): Promise<number | undefined> {
  const v = (await db.device.get(EVENTS_LOGGED_TO))?.value;
  return typeof v === 'number' ? v : undefined;
}

/**
 * Writes the events, and moves the "logged to" point when given, in one quiet write. Never throws:
 * true when stored, false when locked, refused or failed (the events are then simply not recorded).
 */
export async function writeUsage(core: RecordCore, events: readonly UsageEvent[], loggedTo?: number): Promise<boolean> {
  if (events.length === 0 && loggedTo === undefined) return true;
  try {
    const result = await core.write({
      tables: ['changes', 'device'],
      quiet: true,
      async prepare(s, stamp) {
        const puts: Put[] = await eventRows(s.cipher, events, stamp);
        if (loggedTo !== undefined) puts.push({ table: 'device', row: { key: EVENTS_LOGGED_TO, value: loggedTo } });
        return { puts, apply: () => {}, value: undefined };
      },
    });
    return result.kind === 'Saved';
  } catch {
    return false;
  }
}
