import type { HabitKind, HabitPeriod, LocalDate, Observation, PlannedReason, ScheduleEntry, Target, TierPeriod, TriValue } from '../rules/types.ts';
import type { Cue, CueSettings, CueTimes } from '../rules/cues.ts';
import { indexObservations } from '../rules/state.ts';
import type { CueRecord, DayRecord, EntryRecord, HabitRecord, NotYetRecord, ObservationRecord, ReviewRecord, Settings } from './model.ts';
import type { Fields, Opened, Parts, Plain } from './payload.ts';

// The one place stored names meet the rules' names. Rows use snake_case; the app and the rules use
// their own names and units. Value objects (times, fade, target, the settings' minutes) are stored
// exactly in the rules' shapes, so nothing is converted on the way through.

/** Drops keys whose value is undefined, so an absent field stays absent. */
export function defined<T extends object>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
}

function key(plain: Plain, name: string): string {
  const value = plain[name];
  if (value === undefined) throw new Error(`row has no ${name}`);
  return value;
}

const NONE: Fields = {};

export function habitToParts(h: HabitRecord): Parts {
  return {
    plain: { id: h.id },
    r: { name: h.name, sub: h.sub, kind: h.kind, periods: h.periods, tiers: h.tierHistory, schedule: h.schedule, target: h.target, order: h.order, settled_at: h.settledAt, replaces: h.replaces },
  };
}
export function habitFromParts(plain: Plain, opened: Opened): HabitRecord {
  const r = opened.r ?? NONE;
  return defined({
    id: key(plain, 'id'), name: r.name as string, sub: r.sub as string | undefined, kind: r.kind as HabitKind,
    periods: r.periods as HabitPeriod[], schedule: r.schedule as ScheduleEntry[], target: r.target as Target,
    tierHistory: r.tiers as TierPeriod[], order: r.order as number, settledAt: r.settled_at as number | undefined,
    replaces: r.replaces as string | undefined,
  });
}

export function observationToParts(o: ObservationRecord): Parts {
  return {
    plain: { habit_id: o.habitId, local_date: o.date },
    r: { kind: o.kind, value: o.value, planned: o.planned, logged_at: o.loggedAt, is_backfill: o.isBackfill, edited_after_close: o.editedAfterClose },
  };
}
export function observationFromParts(plain: Plain, opened: Opened): ObservationRecord {
  const r = opened.r ?? NONE;
  return defined({
    habitId: key(plain, 'habit_id'), date: key(plain, 'local_date'), kind: r.kind as HabitKind,
    value: r.value as number | TriValue | undefined, planned: r.planned as PlannedReason | undefined,
    loggedAt: r.logged_at as number, isBackfill: r.is_backfill === true, editedAfterClose: r.edited_after_close === true,
  });
}

export function dayToParts(d: DayRecord): Parts {
  return {
    plain: { local_date: d.date },
    r: { closed_at: d.closedAt, lights_out: d.lightsOut, rest_day: d.restDay, reopened_count: d.reopenedCount },
    w: { intent: d.intent, remark: d.remark, bad_night_note: d.badNightNote },
  };
}
export function dayFromParts(plain: Plain, opened: Opened): DayRecord {
  const r = opened.r ?? NONE, w = opened.w ?? NONE;
  return defined({
    date: key(plain, 'local_date'), closedAt: r.closed_at as number | undefined, lightsOut: r.lights_out as number | undefined,
    restDay: r.rest_day === true, reopenedCount: (r.reopened_count as number | undefined) ?? 0,
    intent: w.intent as string | undefined, remark: w.remark as string | undefined, badNightNote: w.bad_night_note as string | undefined,
  });
}

export function entryToParts(e: EntryRecord): Parts {
  return { plain: { id: e.id, local_date: e.date }, w: { body: e.body, trashed_at: e.trashedAt } };
}
export function entryFromParts(plain: Plain, opened: Opened): EntryRecord {
  const w = opened.w ?? NONE;
  return defined({ id: key(plain, 'id'), date: key(plain, 'local_date'), body: (w.body as string | undefined) ?? '', trashedAt: w.trashed_at as number | undefined });
}

export function notYetToParts(n: NotYetRecord): Parts {
  return { plain: { id: n.id }, w: { text: n.text, why: n.why, started_at: n.startedAt, trashed_at: n.trashedAt } };
}
export function notYetFromParts(plain: Plain, opened: Opened): NotYetRecord {
  const w = opened.w ?? NONE;
  return defined({
    id: key(plain, 'id'), text: (w.text as string | undefined) ?? '', why: w.why as string | undefined,
    startedAt: w.started_at as number | undefined, trashedAt: w.trashed_at as number | undefined,
  });
}

export function cueToParts(c: CueRecord): Parts {
  return {
    plain: { id: c.id },
    r: { habit_id: c.habitId, kind: c.kind, times: c.times, fade: c.fade, enabled: c.enabled, private: c.private, created_on: c.createdOn, text: c.private ? undefined : c.text },
    w: { text: c.private ? c.text : undefined },
  };
}
export function cueFromParts(plain: Plain, opened: Opened): CueRecord {
  const r = opened.r ?? NONE, w = opened.w ?? NONE;
  const isPrivate = r.private === true;
  return defined({
    id: key(plain, 'id'), habitId: (r.habit_id as string | null | undefined) ?? null, kind: r.kind as 'checkin' | 'cue',
    text: ((isPrivate ? w.text : r.text) as string | undefined) ?? '', times: r.times as CueTimes, fade: r.fade as Cue['fade'],
    enabled: r.enabled === true, createdOn: r.created_on as LocalDate, private: isPrivate,
  });
}

export function reviewToParts(v: ReviewRecord): Parts {
  return { plain: { key: v.key, period_start: v.periodStart, period_end: v.periodEnd }, w: { answers: v.answers, closed_at: v.closedAt } };
}
export function reviewFromParts(plain: Plain, opened: Opened): ReviewRecord {
  const w = opened.w ?? NONE;
  return defined({
    key: key(plain, 'key'), periodStart: key(plain, 'period_start'), periodEnd: key(plain, 'period_end'),
    answers: (w.answers as Record<string, string> | undefined) ?? {}, closedAt: w.closed_at as number | undefined,
  });
}

/**
 * Each setting's stored key. `wake_plan` and `lights_out_plan` keep a planned clock time apart from
 * a day's observed lights-out.
 */
export const SETTING_KEYS = {
  tz: 'tz', boundary: 'boundary', journeyStart: 'journey_start', wakePlan: 'wake_plan', lightsOutPlan: 'lights_out_plan', cuesOn: 'cues_on', contact: 'contact',
} as const satisfies Record<keyof Settings, string>;

/** One setting as its row's parts: the trusted contact under the words key, every other under the record key. */
export function settingToParts(name: keyof Settings, value: unknown): Parts {
  const plain = { key: SETTING_KEYS[name] };
  return name === 'contact' ? { plain, w: { value } } : { plain, r: { value } };
}

/** All settings, from their rows' values keyed by stored key. */
export function settingsFromValues(values: ReadonlyMap<string, unknown>): Settings {
  const get = (name: keyof Settings) => values.get(SETTING_KEYS[name]);
  return defined({
    tz: get('tz') as string, boundary: get('boundary') as number, journeyStart: get('journeyStart') as LocalDate,
    wakePlan: get('wakePlan') as number, lightsOutPlan: get('lightsOutPlan') as number, cuesOn: get('cuesOn') as boolean,
    contact: get('contact') as string | undefined,
  });
}

/** Every setting that has a value, as [name, value] pairs. */
export function settingEntries(s: Settings): [keyof Settings, unknown][] {
  return (Object.keys(SETTING_KEYS) as (keyof Settings)[])
    .filter(name => s[name] !== undefined)
    .map((name): [keyof Settings, unknown] => [name, s[name]]);
}

/** A cue as the rules see it: a private reminder has no words, so they can never reach a notification. */
export function cueForRules(c: CueRecord): Cue {
  return defined({ id: c.id, habitId: c.habitId, kind: c.kind, text: c.private ? '' : c.text, times: c.times, fade: c.fade, enabled: c.enabled, createdOn: c.createdOn });
}

/** The settings the notification schedule needs, under the rules' names. */
export function cueSettingsOf(s: Settings): CueSettings {
  return { cuesOn: s.cuesOn, wake: s.wakePlan, lightsOut: s.lightsOutPlan, boundary: s.boundary };
}

/**
 * Observations for the rules. On a rest day each habit with nothing stored that day gets a planned
 * rest. Nothing is stored for it, and a habit with a value keeps its value.
 */
export function withRestDays(observations: Iterable<Observation>, restDays: Iterable<LocalDate>, habitIds: readonly string[]): Map<string, Observation> {
  const index = indexObservations([...observations]);
  for (const date of restDays) {
    for (const habitId of habitIds) {
      const k = `${habitId}|${date}`;
      if (!index.has(k)) index.set(k, { habitId, date, planned: 'rest' });
    }
  }
  return index;
}
