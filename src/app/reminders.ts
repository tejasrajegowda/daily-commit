import { dayRule } from '../record/ops/common.ts';
import { readFlag, writeFlag } from '../record/ops/device.ts';
import type { Model } from '../record/model.ts';
import { rulesInput } from '../record/read.ts';
import { todayOf } from '../record/time.ts';
import { cueScheduleAhead } from '../rules/cues.ts';
import { toUtcMs } from '../rules/dates.ts';
import type { ClockMinute, LocalDate } from '../rules/types.ts';
import type { Alarm, AppDeps } from './context.ts';

// The reminders handed to the phone (§6): the next seven days of notices from the rules, each at
// its minute in the home timezone, never the phone's. A private reminder has no words by the time
// the rules see it, so its words can't reach Android. Pause hands over nothing at all, check-ins
// included. The schedule is rebuilt whenever the record changes while open, and handed over only
// when it differs from the last one handed.

export const DAYS_AHEAD = 7;
/** Android refuses more than 500 alarms per app; the earliest 400 are handed over (C-15). */
export const MAX_ALARMS = 400;

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;

/** Minutes east of UTC in `tz` at an instant. */
function offsetMinutes(ms: number, tz: string): number {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(ms)).map(x => [x.type, x.value]));
  const wall = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute), Number(p.second));
  return Math.round((wall - Math.floor(ms / 1000) * 1000) / MINUTE_MS);
}

/**
 * The instant the clock in `tz` reads `at` minutes past midnight on `date`. A time the clocks skip
 * (spring forward) comes as many minutes later as were skipped; a time that happens twice (fall
 * back) is the first of the two.
 */
export function alarmAt(date: LocalDate, at: ClockMinute, tz: string): number {
  const wall = toUtcMs(date) + at * MINUTE_MS;                 // the wall time, read as if it were UTC
  const before = offsetMinutes(wall - DAY_MS, tz);
  const after = offsetMinutes(wall + DAY_MS, tz);
  const fits = (offset: number) => offsetMinutes(wall - offset * MINUTE_MS, tz) === offset;
  const instants = [...new Set([before, after])].filter(fits).map(offset => wall - offset * MINUTE_MS);
  if (instants.length) return Math.min(...instants);
  return wall - before * MINUTE_MS;                            // skipped: the earlier offset lands just after the gap
}

/** The same date and minute always get the same id (whole days since 1970 × 1440 + the minute: a 32-bit int for millennia). */
export const alarmId = (date: LocalDate, at: ClockMinute): number => Math.round(toUtcMs(date) / DAY_MS) * 1440 + at;

/** What to hand to the phone now: the notices of `DAYS_AHEAD` days from `today`, still to come, earliest first. */
export function alarmsFor(model: Model, today: LocalDate, nowMs: number): Alarm[] {
  if (model.settings.paused === true) return [];               // pause sends nothing, check-ins included (§8 #31, C12)
  const input = rulesInput(model);
  const notices = cueScheduleAhead(today, DAYS_AHEAD, input.cues, input.habits, input.index, input.cueSettings);
  const byId = new Map<number, Alarm>();
  for (const n of notices) {
    const atMs = alarmAt(n.date, n.at, model.settings.tz);
    const id = alarmId(n.date, n.at);
    if (atMs <= nowMs || byId.has(id)) continue;               // gone by, or the minute already has its one notification
    byId.set(id, { id, atMs, body: n.texts.filter(t => t.trim() !== '').join(' · ') });
  }
  return [...byId.values()].sort((a, b) => a.atMs - b.atMs).slice(0, MAX_ALARMS);
}

export interface Reminders {
  stop(): void;
  /** resolves once no hand-over is running (for tests) */
  idle(): Promise<void>;
}

/**
 * Hands the schedule to the phone at every store revision while the record is open. `offer` is
 * called once ever, the first time there is something to hand over and Android hasn't been asked.
 */
export function startReminders(deps: AppDeps, offer: () => void): Reminders {
  const port = deps.device.reminders;
  if (!port) return { stop: () => {}, idle: async () => {} };
  let last: string | undefined;
  let running: Promise<void> | undefined;
  let again = false;

  const handOver = async (): Promise<void> => {
    do {
      again = false;
      const s = deps.core.session;
      if (!s) return;                                          // locked: what was handed over stays scheduled
      const now = deps.core.now();
      const alarms = alarmsFor(s.model, todayOf(now, s.lastWriteMs, dayRule(s)), now);
      const key = JSON.stringify(alarms);
      if (key === last) continue;
      const done = await port.replace(alarms);
      last = done === 'scheduled' ? key : undefined;           // not allowed: tried again at the next change
      if (done === 'not-allowed' && !(await readFlag(deps.core.db, 'notif_asked')) && !(await readFlag(deps.core.db, 'notif_offered'))) {
        await writeFlag(deps.core.db, 'notif_offered');
        offer();
      }
    } while (again);
  };

  const run = () => {
    if (running) { again = true; return; }
    running = handOver().catch(() => { last = undefined; }).finally(() => { running = undefined; });
  };

  const stop = deps.store.subscribe(run);
  run();
  return { stop, idle: async () => { while (running) await running; } };
}

/** Android's notification question was asked, once ever. */
export const readNotifAsked = (deps: AppDeps) => readFlag(deps.core.db, 'notif_asked');
/** Marks that question as asked, before the phone shows it. */
export const writeNotifAsked = (deps: AppDeps) => writeFlag(deps.core.db, 'notif_asked');
