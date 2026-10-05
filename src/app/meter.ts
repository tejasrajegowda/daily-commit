import { MIN_PASSPHRASE_CHARS } from './firstRunFlow.ts';

// The passphrase meter: length is what makes it strong, so it counts words once the passphrase is
// long enough, and never shows more than two bars before that. It sees the text only to measure it.

export type Bars = 0 | 1 | 2 | 3 | 4 | 5;

const STRONG_WORDS = 4;
const STRONG_CHARS = 24;

export function meter(text: string): { readonly bars: Bars; readonly label: string } {
  const clean = text.normalize('NFC').trim();
  const length = [...clean].length;
  const words = clean ? clean.split(/\s+/).length : 0;
  if (length < MIN_PASSPHRASE_CHARS) return { bars: Math.min(2, words) as Bars, label: `At least ${MIN_PASSPHRASE_CHARS} characters` };
  const bars = Math.max(1, Math.min(5, words)) as Bars;
  return { bars, label: words >= STRONG_WORDS || length >= STRONG_CHARS ? 'Strong' : 'Long enough' };
}
