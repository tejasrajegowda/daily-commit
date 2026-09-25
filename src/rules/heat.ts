import type { Habit, LocalDate, Observation } from './types.ts';
import { lookup, stateOf, tierOn } from './state.ts';

export type HeatLevel = 0 | 1 | 2 | 3 | 4;

/**
 * The months view: one cell per day, brighter for more of what was in Focus that day.
 * Done counts 1, partly counts a half. Only habits in Focus on that very day count, so a habit
 * that later settled into Log never dims the days it was in Focus. Mood is never part of it.
 */
export function focusDone(habits: readonly Habit[], index: ReadonlyMap<string, Observation>, date: LocalDate): number {
  let v = 0;
  for (const h of habits) {
    if (h.kind === 'mood' || tierOn(h, date) !== 'focus') continue;
    const s = stateOf(h, lookup(index, h.id, date), date);
    if (s === 'did') v += 1;
    else if (s === 'partly') v += 0.5;
  }
  return v;
}

export function heatLevel(focusDoneThatDay: number): HeatLevel {
  const v = focusDoneThatDay;
  return v >= 4 ? 4 : v >= 3 ? 3 : v >= 2 ? 2 : v > 0 ? 1 : 0;
}
