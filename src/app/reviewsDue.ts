import type { Model } from '../record/model.ts';
import { addDays } from '../rules/dates.ts';
import { dayNumber, hasOpened } from '../rules/journey.ts';
import type { LocalDate } from '../rules/types.ts';

// When a review is ready to be offered. Look back offers it; the reviews draw it.

/** Whether the monthly review is ready and not yet closed: the first week of a month, from day 60. */
export function monthDue(model: Model, today: LocalDate): boolean {
  if (!hasOpened('monthlyReview', dayNumber(model.settings.journeyStart, today))) return false;
  if (Number(today.slice(8, 10)) > 7) return false;
  const prev = addDays(`${today.slice(0, 7)}-01`, -1).slice(0, 7);
  return model.reviews.get(`m:${prev}`)?.closedAt === undefined;
}
