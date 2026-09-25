import type { ClockMinute, LocalDate } from './types.ts';
import { weekdayOf } from './dates.ts';

// The day strip at the top of Today. The shape of a day is the owner's data — passed in,
// never written here.

export interface Block {
  readonly start: ClockMinute;
  readonly end: ClockMinute;
  readonly label: string;
}
export interface Step {
  readonly at: ClockMinute;
  readonly label: string;
}
export interface DayShape {
  /** the strip runs from `window.from` to `window.to` */
  readonly window: { readonly from: ClockMinute; readonly to: ClockMinute };
  readonly blocks: readonly Block[];
  /** the reminder-text steps of the day, in time order */
  readonly steps: readonly Step[];
  readonly lightsOut: ClockMinute;
}

/** Saturday and Sunday use the weekend shape; every other day the weekday one. */
export function shapeFor(date: LocalDate, weekday: DayShape, weekend: DayShape): DayShape {
  return weekdayOf(date) >= 5 ? weekend : weekday;
}

/** Where a clock time sits on the strip, 0–100, clamped to the window. */
export function position(shape: DayShape, t: ClockMinute): number {
  const { from, to } = shape.window;
  if (to <= from) return 0;
  return Math.max(0, Math.min(100, ((t - from) / (to - from)) * 100));
}

/** The block the time falls in, if any. */
export function blockAt(shape: DayShape, t: ClockMinute): Block | undefined {
  return shape.blocks.find(b => t >= b.start && t < b.end);
}

/** The latest step already reached, and the next one still to come. */
export function stepsAround(shape: DayShape, t: ClockMinute): { current?: Step; next?: Step } {
  let current: Step | undefined, next: Step | undefined;
  for (const s of shape.steps) {
    if (s.at <= t) current = s;
    else { next = s; break; }
  }
  return { current, next };
}

/** After lights-out and before the window opens, the sun has set. */
export function sunHasSet(shape: DayShape, t: ClockMinute): boolean {
  return t >= shape.lightsOut || t < shape.window.from;
}
