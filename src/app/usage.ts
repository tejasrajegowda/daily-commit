import { dayRule } from '../record/ops/common.ts';
import { readLoggedTo, writeUsage, type UsageEvent } from '../record/ops/usage.ts';
import { rulesInput } from '../record/read.ts';
import type { Model } from '../record/model.ts';
import { appDay } from '../record/time.ts';
import { cueScheduleAhead } from '../rules/cues.ts';
import { addDays, fromUtcMs } from '../rules/dates.ts';
import type { Alarm, AppDeps } from './context.ts';
import { alarmAt, alarmId } from './reminders.ts';

// Usage events (D-26, U6b Task 9), written only while the record is open and never shown anywhere.
// "Opened" and the taps held since are written when the lock machine reaches Open. "Shown" is logged
// just before every hand-over of the schedule, from the list last handed to Android, so a reminder is
// noted as shown only if the app really handed it over; the first hand-over after a start has no list
// in memory and works it out from the record, which nothing has changed since the last hand-over
// (every change is followed by one). Android shows a reminder without running the app, so "shown"
// means its due time has passed, plus whether it was still in the tray at that moment.

const DAY_MS = 86_400_000;
/** A gap longer than this since the last logged point is not worked out: the schedule handed then reached 7 days ahead. */
export const SHOWN_WINDOW_MS = 6 * DAY_MS;

/** The day an alarm id names, and its minute: ids are whole days since 1970 × 1440 + the minute. */
export function dueOf(id: number, tz: string): number {
  const days = Math.floor(id / 1440);
  return alarmAt(fromUtcMs(days * DAY_MS), id - days * 1440, tz);
}

/**
 * The reminders the record schedules with a due time in (fromMs, toMs], earliest first, one per minute.
 * Pause schedules nothing. The same rules as the hand-over (reminders.ts alarmsFor).
 */
export function scheduledBetween(model: Model, firstDay: ReturnType<typeof fromUtcMs>, fromMs: number, toMs: number): Alarm[] {
  if (model.settings.paused === true || toMs <= fromMs) return [];
  const input = rulesInput(model);
  const days = Math.ceil((toMs - fromMs) / DAY_MS) + 2;
  const byId = new Map<number, Alarm>();
  for (const n of cueScheduleAhead(firstDay, days, input.cues, input.habits, input.index, input.cueSettings)) {
    const atMs = alarmAt(n.date, n.at, model.settings.tz);
    const id = alarmId(n.date, n.at);
    if (atMs <= fromMs || atMs > toMs || byId.has(id)) continue;
    byId.set(id, { id, atMs, body: '' });
  }
  return [...byId.values()].sort((a, b) => a.atMs - b.atMs);
}

/**
 * Logs the reminders shown since the last logged point, up to now, and moves the point to now, in one quiet
 * write. `handed` is the list last handed to Android in this run, when there is one. The first time ever,
 * only the point is set: no history is made up.
 */
export async function logShown(deps: AppDeps, handed: readonly Alarm[] | undefined): Promise<void> {
  const s = deps.core.session;
  const port = deps.device.reminders;
  if (!s || !port) return;
  const now = deps.core.now();
  const from = await readLoggedTo(deps.core.db).catch(() => undefined);
  if (from === undefined) { await writeUsage(deps.core, [], now); return; }
  if (now <= from) return;
  const to = Math.min(now, from + SHOWN_WINDOW_MS);
  const due = handed !== undefined
    ? handed.filter(a => a.atMs > from && a.atMs <= to)
    // the logged point's own app day (todayOf would jump ahead to the day of the last save), one day earlier to be safe
    : scheduledBetween(s.model, addDays(appDay(from, dayRule(s)), -1), from, to);
  if (due.length === 0) { await writeUsage(deps.core, [], now); return; }
  let tray: ReadonlySet<number> | undefined;
  try { tray = port.delivered ? new Set(await port.delivered()) : undefined; } catch { tray = undefined; }
  const events: UsageEvent[] = due.map(a => tray === undefined
    ? { type: 'reminder-shown', due: a.atMs }
    : { type: 'reminder-shown', due: a.atMs, in_tray: tray.has(a.id) });
  await writeUsage(deps.core, events, now);
}

export interface Usage {
  stop(): void;
  /** resolves once no write is running (for tests) */
  idle(): Promise<void>;
}

/**
 * Writes "opened" each time the machine reaches Open, with the taps held since. A tap while locked is held in
 * memory (no key to seal it with) and written with the next "opened", exactly once.
 */
export function startUsage(deps: AppDeps): Usage {
  const taps: number[] = [];
  let running: Promise<void> = Promise.resolve();
  let wasOpen = deps.machine.state.kind === 'Open';

  const flush = (opened: boolean) => {
    running = running.then(async () => {
      const s = deps.core.session;
      if (!s) return;
      const held = taps.splice(0, taps.length);
      const events: UsageEvent[] = [
        ...(opened ? [{ type: 'opened' } as const] : []),
        ...held.map(id => ({ type: 'reminder-tapped', due: dueOf(id, s.model.settings.tz) } as const)),
      ];
      if (events.length === 0) return;
      // locked part-way: the taps go with the next opening; any other failure means they are simply not recorded
      if (!(await writeUsage(deps.core, events)) && !deps.core.session) taps.unshift(...held);
    });
  };

  const stopMachine = deps.machine.listen(state => {
    const open = state.kind === 'Open';
    if (open && !wasOpen) flush(true);
    wasOpen = open;
  });
  const stopTaps = deps.device.reminders?.onTapped?.(id => {
    taps.push(id);
    if (deps.machine.state.kind === 'Open') flush(false);
  }) ?? (() => {});

  return {
    stop: () => { stopMachine(); stopTaps(); },
    idle: async () => { await running; },
  };
}
