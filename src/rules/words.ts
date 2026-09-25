// Weeks and months are described in words, never in numbers or percentages.

export type Band = 'most' | 'half' | 'few';
export type Momentum = 'building' | 'steady' | 'dipped' | 'strong';

/** At least 7 in 10 of the days it was asked → most; 4 in 10 → half; any at all → few. */
export function band(done: number, asked: number): Band | null {
  if (asked <= 0 || done <= 0) return null;
  if (done * 10 >= asked * 7) return 'most';
  if (done * 10 >= asked * 4) return 'half';
  return 'few';
}

export const BAND_WORDS = {
  week: { most: 'most days', half: 'about half', few: 'a few days', none: 'a quiet week' },
  month: { most: 'most days', half: 'about half the days', few: 'a few days', none: 'a quiet month' },
} as const;

export function bandWords(b: Band | null, period: keyof typeof BAND_WORDS): string {
  return BAND_WORDS[period][b ?? 'none'];
}

/**
 * Building: two or more days more than the period before. Dipped: two or more fewer.
 * Strong: five or more days, holding. Steady: anything in between.
 */
export function momentum(before: number, now: number): Momentum {
  if (now >= before + 2) return 'building';
  if (now <= before - 2) return 'dipped';
  if (now >= 5) return 'strong';
  return 'steady';
}

const SMALL = ['no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve'];
/** Small counts read as words in sentences ("eight mornings"); larger ones as numerals. */
export function countWord(n: number): string {
  return SMALL[n] ?? String(n);
}
