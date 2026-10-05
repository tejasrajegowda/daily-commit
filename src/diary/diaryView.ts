import type { EntryRecord, Model, NotYetRecord } from '../record/model.ts';
import { TRASH_MS } from '../record/ops/words.ts';
import { addDays, toUtcMs } from '../rules/dates.ts';
import type { LocalDate } from '../rules/types.ts';

// The diary's index and trash, worked out from the record. Only the person's own screen ever shows
// the words; nothing here counts, scores or summarises them.

const DOW = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MON = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** Pages not in the trash, newest first. */
export function pages(model: Model): EntryRecord[] {
  return [...model.entries.values()].filter(e => e.trashedAt === undefined).sort((a, b) => (a.date === b.date ? (a.id < b.id ? 1 : -1) : a.date < b.date ? 1 : -1));
}

/** Today's page, if one was started today. */
export function todaysPage(model: Model, today: LocalDate): EntryRecord | undefined {
  return pages(model).find(e => e.date === today);
}

/** Pages and Not-yet items waiting in the trash, with the day their words go. */
export function inTrash<T extends EntryRecord | NotYetRecord>(items: Iterable<T>): { readonly item: T; readonly goneAt: number }[] {
  return [...items].filter(x => x.trashedAt !== undefined).map(item => ({ item, goneAt: (item.trashedAt ?? 0) + TRASH_MS }));
}

/** When an id made by the app was made: its first 48 bits are the time (UUIDv7). */
export function writtenAt(id: string): number | undefined {
  const hex = id.replaceAll('-', '');
  if (!/^[0-9a-f]{32}$/i.test(hex) || hex[12] !== '7') return undefined;
  return Number.parseInt(hex.slice(0, 12), 16);
}

/** "Today", "Yesterday", or "Tuesday 22". */
export function dayLabel(date: LocalDate, today: LocalDate): string {
  if (date === today) return 'Today';
  if (date === addDays(today, -1)) return 'Yesterday';
  const d = new Date(toUtcMs(date));
  return `${DOW[d.getUTCDay()]} ${d.getUTCDate()}`;
}

export const longDate = (date: LocalDate) => {
  const d = new Date(toUtcMs(date));
  return `${DOW[d.getUTCDay()]} ${d.getUTCDate()} ${MON[d.getUTCMonth()]}`;
};

/** A day and month for an instant, in the home timezone: "12 January". */
export function dayOf(ms: number, tz: string): string {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: tz, day: 'numeric', month: 'numeric' }).formatToParts(ms).map(x => [x.type, x.value]));
  return `${p.day} ${MON[Number(p.month) - 1]}`;
}

/** The first line of a page, for the index. */
export const firstLine = (body: string) => body.trim().split('\n')[0]?.slice(0, 80) ?? '';

export const DIARY_WORDS = {
  trashAsk: 'Move this page to the trash?',
  trashSay: 'It stays in the trash for 7 days, and you can put it back until then. After that its words are wiped, from this phone and from every copy made afterwards.',
  trashYes: 'Move to trash',
  trashNo: 'Keep it',
  notYetIntro: "Things you're thinking about. Nothing here is tracked, counted, scheduled or brought up by the app.",
} as const;
