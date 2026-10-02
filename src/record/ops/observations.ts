import type { LocalDate, PlannedReason, TriValue } from '../../rules/types.ts';
import { askedOn, isAsked } from '../../rules/state.ts';
import type { Put, RecordCore } from '../core.ts';
import type { DayRecord, ObservationRecord } from '../model.ts';
import { dayToParts, observationToParts } from '../mapping.ts';
import { invalid, type Result } from '../results.ts';
import type { Sheet } from '../time.ts';
import { validReason, validValue } from '../validate.ts';
import { judgedNow, sealCheck, storedRow, tombstone } from './common.ts';

// What happened on a day, one habit at a time. A value and a plan are never both set: logging a
// value clears the plan ("did" wins), and a plan is refused where a value is already logged.

export interface LogInput {
  readonly habitId: string;
  readonly date: LocalDate;
  /** stored exactly as given; for a time habit, a DayMinute the screen made with toDayMinute */
  readonly value: number | TriValue;
  readonly sheet?: Sheet;
}

export interface DayPlan {
  readonly date: LocalDate;
  /** habits planned in advance for the day, each with its reason */
  readonly plans?: readonly { readonly habitId: string; readonly reason: PlannedReason }[];
  /** the whole day as a rest day, or not */
  readonly restDay?: boolean;
  readonly sheet?: Sheet;
}

export function logObservation(core: RecordCore, input: LogInput): Promise<Result<void>> {
  return core.write({
    tables: ['observations'],
    async prepare(s, stamp) {
      const h = s.model.habits.get(input.habitId);
      if (!h) return invalid('no such habit');
      if (!validValue(h.kind, input.value, s.model.settings.boundary)) return invalid(`not a ${h.kind} value`);
      if (!isAsked(h, input.date)) return invalid('not asked that day');
      const check = sealCheck(core, s, input.date, 'value', input.sheet, askedOn(h, input.date) === 'morning');
      const refused = check();
      if (refused) return refused;
      const { today } = judgedNow(core, s, input.sheet);
      const obs: ObservationRecord = {
        habitId: h.id, date: input.date, kind: h.kind, value: input.value, loggedAt: stamp.updated_at,
        isBackfill: input.date < today, editedAfterClose: s.model.days.get(input.date)?.closedAt !== undefined,
      };
      return {
        puts: [{ table: 'observations', row: await storedRow(s.cipher, 'observations', observationToParts(obs), stamp) }],
        check,
        apply: m => { m.observations.set(`${h.id}|${input.date}`, obs); },
        value: undefined,
      };
    },
  });
}

export function clearObservation(core: RecordCore, input: { readonly habitId: string; readonly date: LocalDate; readonly sheet?: Sheet }): Promise<Result<void>> {
  return core.write({
    tables: ['observations'],
    async prepare(s, stamp) {
      const key = `${input.habitId}|${input.date}`;
      const existing = s.model.observations.get(key);
      if (!existing) return invalid('nothing to clear');
      const h = s.model.habits.get(input.habitId);
      const morning = h !== undefined && askedOn(h, input.date) === 'morning';
      const check = sealCheck(core, s, input.date, existing.value === undefined ? 'plan' : 'value', input.sheet, morning);
      const refused = check();
      if (refused) return refused;
      return {
        puts: [{ table: 'observations', row: tombstone(observationToParts(existing), stamp) }],
        check,
        apply: m => { m.observations.delete(key); },
        value: undefined,
      };
    },
  });
}

export function planDay(core: RecordCore, input: DayPlan): Promise<Result<void>> {
  return core.write({
    tables: ['observations', 'days'],
    async prepare(s, stamp) {
      const check = sealCheck(core, s, input.date, 'plan', input.sheet);
      const refused = check();
      if (refused) return refused;
      const { today } = judgedNow(core, s, input.sheet);
      const planned: ObservationRecord[] = [];
      for (const p of input.plans ?? []) {
        const h = s.model.habits.get(p.habitId);
        if (!h || !isAsked(h, input.date)) return invalid('not asked that day');
        if (!validReason(p.reason)) return invalid('not a reason');
        if (s.model.observations.get(`${h.id}|${input.date}`)?.value !== undefined) return invalid('already logged that day');
        planned.push({
          habitId: h.id, date: input.date, kind: h.kind, planned: p.reason, loggedAt: stamp.updated_at,
          isBackfill: input.date < today, editedAfterClose: s.model.days.get(input.date)?.closedAt !== undefined,
        });
      }
      const puts: Put[] = await Promise.all(planned.map(async (o): Promise<Put> =>
        ({ table: 'observations', row: await storedRow(s.cipher, 'observations', observationToParts(o), stamp) })));
      let day: DayRecord | undefined;
      if (input.restDay !== undefined) {
        day = { ...(s.model.days.get(input.date) ?? { date: input.date, restDay: false, reopenedCount: 0 }), restDay: input.restDay };
        puts.push({ table: 'days', row: await storedRow(s.cipher, 'days', dayToParts(day), stamp) });
      }
      if (puts.length === 0) return invalid('nothing to plan');
      return {
        puts,
        check,
        apply: m => {
          for (const o of planned) m.observations.set(`${o.habitId}|${o.date}`, o);
          if (day) m.days.set(day.date, day);
        },
        value: undefined,
      };
    },
  });
}
