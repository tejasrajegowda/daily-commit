import type { Settings } from '../record/model.ts';
import type { DayShape, DayShapes } from '../rules/dayLine.ts';

// The shape of a day when none has been set: plain blocks and steps, the same for anyone. The
// owner's own shape is data, set in Plan, never written here.

const WINDOW = { from: 300, to: 1410 } as const;

const WEEKDAY: DayShape = {
  window: WINDOW,
  blocks: [{ start: 360, end: 720, label: 'Morning' }, { start: 720, end: 1080, label: 'Day' }, { start: 1140, end: 1380, label: 'Evening' }],
  steps: [{ at: 360, label: 'Up' }, { at: 720, label: 'Midday' }, { at: 1140, label: 'Evening' }, { at: 1320, label: 'Wind down' }],
  lightsOut: 1380,
};

const WEEKEND: DayShape = {
  window: WINDOW,
  blocks: [{ start: 390, end: 720, label: 'Morning' }, { start: 720, end: 1140, label: 'The day' }, { start: 1170, end: 1380, label: 'Evening' }],
  steps: [{ at: 390, label: 'Up, slowly' }, { at: 600, label: 'The day is yours' }, { at: 1170, label: 'Evening' }, { at: 1320, label: 'Wind down' }],
  lightsOut: 1380,
};

export const DEFAULT_SHAPES: DayShapes = { weekday: WEEKDAY, weekend: WEEKEND };

export function shapesOf(settings: Settings): DayShapes {
  return settings.dayShapes ?? DEFAULT_SHAPES;
}
