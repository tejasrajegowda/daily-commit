import type { LocalDate } from '../../rules/types.ts';
import { addDays, weekdayOf } from '../../rules/dates.ts';
import type { RecordCore } from '../core.ts';
import type { ReviewRecord } from '../model.ts';
import { defined, reviewToParts } from '../mapping.ts';
import { invalid, type Result } from '../results.ts';
import { storedRow } from './common.ts';

// The Sunday review covers Monday to Sunday; the monthly review covers its month. Each is keyed by
// its first day, never by a week number.

export interface ReviewSave {
  readonly period: 'week' | 'month';
  /** a Monday for a week, the 1st for a month */
  readonly start: LocalDate;
  readonly answers: Readonly<Record<string, string>>;
  readonly close?: boolean;
}

/** A review's key and its last day, or undefined if `start` can't begin that kind of period. */
export function reviewPeriod(period: 'week' | 'month', start: LocalDate): { readonly key: string; readonly end: LocalDate } | undefined {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start)) return undefined;
  if (period === 'week') return weekdayOf(start) === 0 ? { key: `w:${start}`, end: addDays(start, 6) } : undefined;
  if (!start.endsWith('-01')) return undefined;
  const y = Number(start.slice(0, 4)), m = Number(start.slice(5, 7));
  const nextMonth = m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`;
  return { key: `m:${start.slice(0, 7)}`, end: addDays(nextMonth, -1) };
}

export function saveReview(core: RecordCore, input: ReviewSave): Promise<Result<void>> {
  return core.write({
    tables: ['reviews'],
    async prepare(s, stamp) {
      const period = reviewPeriod(input.period, input.start);
      if (!period) return invalid('a week starts on a Monday, a month on its 1st');
      if (!Object.values(input.answers).every(v => typeof v === 'string')) return invalid('answers are text');
      const existing = s.model.reviews.get(period.key);
      const review: ReviewRecord = defined({
        key: period.key, periodStart: input.start, periodEnd: period.end, answers: input.answers,
        closedAt: input.close ? (existing?.closedAt ?? stamp.updated_at) : existing?.closedAt,
      });
      return {
        puts: [{ table: 'reviews', row: await storedRow(s.cipher, 'reviews', reviewToParts(review), stamp) }],
        apply: m => { m.reviews.set(review.key, review); },
        value: undefined,
      };
    },
  });
}
