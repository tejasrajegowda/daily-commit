// Pure readings for the U6 rehearsal. No device, no files, no clock change: the runner and the
// unit tests share these so a FAIL line can only be a fixed word, a number, or an error type.

const BODY = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const CHECKS = `${BODY}*$~=U`;

export const REHEARSAL_DAY = 2;

function pad(n: number, width: number): string {
  return String(n).padStart(width, '0');
}

function inRange(n: number, lo: number, hi: number): boolean {
  return Number.isInteger(n) && n >= lo && n <= hi;
}

/** Toybox `date` argument: MMDDhhmmCCYY.ss, local time on the emulator. */
export function dateSetArg(month: number, day: number, hour: number, minute: number, year: number): string {
  if (!inRange(month, 1, 12)) throw new RangeError('month');
  if (!inRange(day, 1, 31)) throw new RangeError('day');
  if (!inRange(hour, 0, 23)) throw new RangeError('hour');
  if (!inRange(minute, 0, 59)) throw new RangeError('minute');
  if (!inRange(year, 1970, 2099)) throw new RangeError('year');
  return `${pad(month, 2)}${pad(day, 2)}${pad(hour, 2)}${pad(minute, 2)}${pad(year, 4)}.00`;
}

/** The two spellings to try, in order. The one whose read-back matches is the one that worked. */
export function dateSetCommands(arg: string): readonly string[] {
  return [`date ${arg}`, `toybox date ${arg}`];
}

/** `date +%Y-%m-%dT%H` for the invented day, so the runner can confirm the clock before it continues. */
export function clockStamp(month: number, day: number, hour: number, year = 2026): string {
  return `${year}-${pad(month, 2)}-${pad(day, 2)}T${pad(hour, 2)}`;
}

/** True when any line of the clock read-back is exactly the expected local hour. */
export function clockReadback(out: string, expect: string): boolean {
  return out.split(/\r?\n/).some(line => line.trim() === expect);
}

function compactCode(text: string): string | undefined {
  const s = text.replace(/[\s-]/g, '').toUpperCase();
  if (s.length !== 41) return undefined;
  for (let i = 0; i < 40; i++) if (!BODY.includes(s.charAt(i))) return undefined;
  if (!CHECKS.includes(s.charAt(40))) return undefined;
  return s;
}

/**
 * The recovery code as the screen exposes it: one label, or eight groups of five plus the check.
 * Returns the 41 characters with spaces removed. Nothing here checks the check symbol's sum.
 */
export function recoveryFromLabels(labels: readonly string[]): string | undefined {
  for (const label of labels) {
    const one = compactCode(label);
    if (one !== undefined) return one;
  }
  const tokens: string[] = [];
  for (const label of labels) {
    for (const part of label.trim().split(/\s+/)) if (part.length > 0) tokens.push(part.toUpperCase());
  }
  for (let i = 0; i + 8 < tokens.length; i++) {
    const groups = tokens.slice(i, i + 8);
    const check = tokens[i + 8];
    if (check === undefined) continue;
    const groupsOk = groups.every(g => g.length === 5 && [...g].every(c => BODY.includes(c)));
    if (groupsOk && check.length === 1 && CHECKS.includes(check)) return groups.join('') + check;
  }
  return undefined;
}

/** Day N from a "Day 2 · …" line, or from the two nodes "Day" and "2". "Day and time" is not a day. */
export function dayNumberFrom(labels: readonly string[]): number | undefined {
  for (let i = 0; i < labels.length; i++) {
    const label = labels[i];
    if (label === undefined) continue;
    const found = /^Day (\d+)\b/.exec(label)?.[1];
    if (found !== undefined) return Number(found);
    if (label === 'Day') {
      const next = labels[i + 1];
      if (next !== undefined && /^\d+$/.test(next)) return Number(next);
    }
  }
  return undefined;
}

export function todayClosed(labels: readonly string[]): boolean {
  return labels.some(l => l.includes("That's the day")) && labels.some(l => l.includes('Open today again'));
}

export function yesterdayClosed(labels: readonly string[]): boolean {
  return labels.some(l => l.includes("That's the day")) && labels.some(l => l.includes('Open it again'));
}

/** Version tokens that start a label. A sentence that merely mentions one does not count. */
export function changeVersions(labels: readonly string[]): string[] {
  const out: string[] = [];
  for (const label of labels) {
    const found = /^(\d+\.\d+\.\d+)(?!\d)/.exec(label.trim())?.[1];
    if (found !== undefined) out.push(found);
  }
  return out;
}

/** The oldest "What changed" line. The phone runs the next sentence on with no space ("0.1.0The first…"), so only
 * another digit ends the match, never a word boundary. */
export const OLDEST_LINE = /^0\.1\.0(?!\d)/;

/** The "What changed" heading. An eyebrow heading is set in capitals, and the phone reads it out that way. */
export const CHANGED_HEADING = /^What changed$/i;

/** About after the rehearsal install: the heading is there, and 0.1.1 is listed before 0.1.0. */
export function aboutOrder(labels: readonly string[]): 'yes' | 'missing' | 'order' {
  const at = labels.findIndex(l => CHANGED_HEADING.test(l) || /^What changed\s+\d/i.test(l));
  if (at < 0) return 'missing';
  // Only what follows the heading (About's own "version 0.1.1" line comes before it). The phone can read the
  // whole list as one run of text with no gaps, so every version in it counts, not only one at a label's start.
  const after = labels.slice(at).map(l => l.replace(CHANGED_HEADING, '').replace(/^What changed/i, ''));
  const versions = after.flatMap(l => [...l.matchAll(/(?<!\d)(?<!\d\.)(\d+\.\d+\.\d+)(?!\d)/g)].map(m => m[1] ?? ''));
  if (versions[0] === '0.1.1' && versions[1] === '0.1.0') return 'yes';
  if (!versions.includes('0.1.1') || !versions.includes('0.1.0')) return 'missing';
  return 'order';
}

const COPY_NAME = /^\d{13}\.json\.gz$/;

/** File names only. A path is reduced to its last segment; anything else is ignored. */
export function preupgradeNames(lines: readonly string[]): string[] {
  const out: string[] = [];
  for (const line of lines) {
    const base = line.trim().split(/[\\/]/).pop() ?? '';
    if (COPY_NAME.test(base) && !out.includes(base)) out.push(base);
  }
  return out;
}

/** Why an install ended. `yes` is the only success. The words match the installer's own sentences. */
export function installWhy(out: string, code: number): 'yes' | 'signer' | 'older' | 'version' | 'refused' {
  if (code === 0 && /Installed .+ over what was there/.test(out)) return 'yes';
  if (out.includes('different key')) return 'signer';
  if (out.includes('older version')) return 'older';
  if (out.includes('version code')) return 'version';
  return 'refused';
}

export function versionIs(text: string, expected: string): boolean {
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== 'object' || parsed === null || !('version' in parsed)) return false;
    return parsed.version === expected;
  } catch {
    return false;
  }
}

/** The first package version only, so a later copy of the same digits is left as it was. */
export function patchPackageVersion(src: string): string | undefined {
  const needle = '"version": "0.1.0"';
  const at = src.indexOf(needle);
  if (at < 0) return undefined;
  return `${src.slice(0, at)}"version": "0.1.1"${src.slice(at + needle.length)}`;
}

export function patchAppVersion(src: string): string | undefined {
  const needle = "export const APP_VERSION = '0.1.0'";
  const at = src.indexOf(needle);
  if (at < 0) return undefined;
  return `${src.slice(0, at)}export const APP_VERSION = '0.1.1'${src.slice(at + needle.length)}`;
}

/** Inserts the rehearsal line as the first entry. The newline already in the file is kept. */
export function patchChanges(src: string): string | undefined {
  const found = /export const CHANGES: readonly Change\[\] = \[\r?\n/.exec(src);
  if (found === null) return undefined;
  const nl = found[0].endsWith('\r\n') ? '\r\n' : '\n';
  const line = `  { version: '0.1.1', line: 'Rehearsal build.' },${nl}`;
  const at = found.index + found[0].length;
  return src.slice(0, at) + line + src.slice(at);
}

export interface TapBox {
  readonly text: string;
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}

/**
 * The smallest label whose top is on screen above the dock. A row button can be taller than the
 * screen, so its centre is not a safe tap: that point falls on the dock.
 */
export function nameBox(boxes: readonly TapBox[], label: RegExp, dock: number, width: number, height: number): TapBox | undefined {
  const hits = boxes.filter(b => {
    if (!label.test(b.text)) return false;
    if (b.right <= b.left || b.bottom <= b.top) return false;
    const cx = (b.left + b.right) / 2;
    return b.top >= 0 && b.top < dock && b.top < height && cx >= 0 && cx < width;
  });
  hits.sort((a, b) => ((a.right - a.left) * (a.bottom - a.top)) - ((b.right - b.left) * (b.bottom - b.top)));
  return hits[0];
}

/** Where to tap a label. A short one is tapped in the middle. A tall one is tapped near its top. */
export function namePoint(box: TapBox, dock: number): readonly [number, number] {
  const x = Math.floor((box.left + box.right) / 2);
  const mid = Math.floor((box.top + box.bottom) / 2);
  if (mid < dock) return [x, mid];
  const room = dock - box.top;
  const y = Math.floor(box.top + Math.min(36, Math.max(8, room / 2)));
  return [x, y];
}
