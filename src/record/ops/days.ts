import type { ClockMinute, DayMinute, LocalDate } from '../../rules/types.ts';
import { isDayMinute } from '../../rules/clock.ts';
import type { RecordCore } from '../core.ts';
import type { DayRecord } from '../model.ts';
import { dayToParts, defined } from '../mapping.ts';
import { invalid, type Refusal, type Result } from '../results.ts';
import type { Sheet } from '../time.ts';
import { sealCheck, storedRow } from './common.ts';

// A day as a whole: closing it, reopening it, and its words (the morning intent, the evening
// remark, a bad-night note), which are locked under the words key. All of it takes the seal.

export interface DayWords {
  readonly date: LocalDate;
  readonly intent?: string;
  readonly remark?: string;
  readonly badNightNote?: string;
  readonly sheet?: Sheet;
}

function changeDay(
  core: RecordCore, date: LocalDate, sheet: Sheet | undefined,
  change: (day: DayRecord, stampAt: number, boundary: ClockMinute) => DayRecord | Refusal,
): Promise<Result<void>> {
  return core.write({
    tables: ['days'],
    async prepare(s, stamp) {
      const check = sealCheck(core, s, date, 'value', sheet);
      const refused = check();
      if (refused) return refused;
      const day = s.model.days.get(date) ?? { date, restDay: false, reopenedCount: 0 };
      const next = change(day, stamp.updated_at, s.model.settings.boundary);
      if (!('date' in next)) return next;
      return {
        puts: [{ table: 'days', row: await storedRow(s.cipher, 'days', dayToParts(next), stamp) }],
        check,
        apply: m => { m.days.set(date, next); },
        value: undefined,
      };
    },
  });
}

export function closeDay(core: RecordCore, input: { readonly date: LocalDate; readonly lightsOut?: DayMinute; readonly sheet?: Sheet }): Promise<Result<void>> {
  return changeDay(core, input.date, input.sheet, (day, at, boundary) => {
    if (day.closedAt !== undefined) return invalid('already closed');
    if (input.lightsOut !== undefined && !isDayMinute(input.lightsOut, boundary)) return invalid('lights-out is not a time of that night');
    return defined({ ...day, closedAt: at, lightsOut: input.lightsOut ?? day.lightsOut });
  });
}

export function reopenDay(core: RecordCore, input: { readonly date: LocalDate; readonly sheet?: Sheet }): Promise<Result<void>> {
  return changeDay(core, input.date, input.sheet, day =>
    day.closedAt === undefined ? invalid('not closed') : defined({ ...day, closedAt: undefined, reopenedCount: day.reopenedCount + 1 }));
}

export function saveDayWords(core: RecordCore, input: DayWords): Promise<Result<void>> {
  return changeDay(core, input.date, input.sheet, day => defined({
    ...day, intent: input.intent ?? day.intent, remark: input.remark ?? day.remark, badNightNote: input.badNightNote ?? day.badNightNote,
  }));
}
