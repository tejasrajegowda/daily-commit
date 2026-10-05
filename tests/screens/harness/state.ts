// What a harness page shows, read from its URL as the design preview reads its own:
// #s=<screen>&v=<variant>&t=<HH:MM>&age=<day number>. Everything is invented and in UTC.

export interface HarnessState {
  /** s=, the screen; default 'today' */
  readonly screen: string;
  /** v=, a variant of that screen; default '' */
  readonly variant: string;
  /** t=HH:MM, minutes after midnight; default 13:00 */
  readonly minute: number;
  /** age=, the day number counted from 1; default 17 */
  readonly day: number;
  /** canary=1: yesterday holds marked values, for the check that the morning shows no earlier day */
  readonly canary: boolean;
}

/** The record's first day: a Monday. */
export const START = '2026-01-05';

const DAY_MS = 86_400_000;

function minuteOf(text: string | null): number | undefined {
  const m = /^(\d{1,2}):(\d{2})$/.exec(text ?? '');
  if (!m) return undefined;
  const minute = Number(m[1]) * 60 + Number(m[2]);
  return minute < 1440 ? minute : undefined;
}

export function readState(hash: string): HarnessState {
  const q = new URLSearchParams(hash.replace(/^#/, ''));
  const age = Number(q.get('age'));
  return {
    screen: q.get('s') || 'today',
    variant: q.get('v') || '',
    minute: minuteOf(q.get('t')) ?? 780,
    day: q.has('age') && Number.isInteger(age) ? Math.max(1, age) : 17,
    canary: q.get('canary') === '1',
  };
}

/** The calendar date of a day number; day 1 is START. */
export function dateOfDay(day: number): string {
  return new Date(Date.parse(`${START}T00:00:00Z`) + (day - 1) * DAY_MS).toISOString().slice(0, 10);
}

/** The harness's fixed clock: the day, at the minute, in UTC. */
export function nowOf(state: HarnessState): number {
  return Date.parse(`${dateOfDay(state.day)}T00:00:00Z`) + state.minute * 60_000;
}
