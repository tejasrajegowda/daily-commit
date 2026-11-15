import type { LocalDate, PlannedReason, TriValue } from '../../rules/types.ts';
import { askedOn, isAsked } from '../../rules/state.ts';
import { restCounts } from '../../rules/rest.ts';
import type { Put, RecordCore } from '../core.ts';
import type { DayRecord, ObservationRecord } from '../model.ts';
import { dayToParts, defined, observationToParts, restMarks } from '../mapping.ts';
import { invalid, type Result } from '../results.ts';
import type { Sheet } from '../time.ts';
import { validReason, validValue } from '../validate.ts';
import { judgedNow, sealCheck, storedRow, tombstone } from './common.ts';

// What happened on a day, one habit at a time. A value and a plan are never both set: logging a
// value clears the plan ("did" wins), and a plan is refused where a value is already logged.
//
// A plan is judged once, when first saved (D-30, D-31): made before its day began or not, and whether
// it uses one of the month's two days and so keeps the habit's run. A re-save changes only its reason.
// A rest day is taken only in advance and only while its month has one left; a rest day or an advance
// plan can be taken back until its day begins, and is fixed after that.

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
      if (existing.inAdvance === true && !(input.date > judgedNow(core, s, input.sheet).today)) return invalid('too late');
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
      const ahead = input.date > today;
      const counts = ahead && restCounts(restMarks(s.model), input.date);
      const planned: ObservationRecord[] = [];
      for (const p of input.plans ?? []) {
        const h = s.model.habits.get(p.habitId);
        if (!h || !isAsked(h, input.date)) return invalid('not asked that day');
        if (!validReason(p.reason)) return invalid('not a reason');
        const existing = s.model.observations.get(`${h.id}|${input.date}`);
        if (existing?.value !== undefined) return invalid('already logged that day');
        planned.push(existing?.planned !== undefined
          ? { ...existing, planned: p.reason }
          : {
            habitId: h.id, date: input.date, kind: h.kind, planned: p.reason, loggedAt: stamp.updated_at,
            isBackfill: input.date < today, editedAfterClose: s.model.days.get(input.date)?.closedAt !== undefined,
            inAdvance: ahead, markedOn: today, keepsRun: counts,
          });
      }
      const puts: Put[] = await Promise.all(planned.map(async (o): Promise<Put> =>
        ({ table: 'observations', row: await storedRow(s.cipher, 'observations', observationToParts(o), stamp) })));
      let day: DayRecord | undefined;
      const before = s.model.days.get(input.date) ?? { date: input.date, restDay: false, reopenedCount: 0 };
      if (input.restDay === true && !before.restDay) {
        if (!ahead) return invalid('too late');
        if (!counts) return invalid('none left this month');
        day = { ...before, restDay: true, restInAdvance: true, restMarkedOn: today };
      } else if (input.restDay === false && before.restDay) {
        if (!ahead) return invalid('too late');
        day = defined({ ...before, restDay: false, restInAdvance: undefined, restMarkedOn: undefined });
      }
      if (day) puts.push({ table: 'days', row: await storedRow(s.cipher, 'days', dayToParts(day), stamp) });
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
