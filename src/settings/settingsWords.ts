import type { CueRecord, Settings } from '../record/model.ts';

// Settings' words, kept apart from the screen so a test can read every line: nothing stale from the
// design rounds, and no exclamation marks or percentages.

export type Category = 'day' | 'display' | 'privacy' | 'data' | 'pause' | 'support' | 'about';

export const CATEGORIES: readonly (readonly [Category, string])[] = [
  ['day', 'Day and time'], ['display', 'Display'], ['privacy', 'Privacy'], ['data', 'Your data'], ['pause', 'Pause'],
  ['support', 'Support'], ['about', 'About'],
];

/** Today's own switch from morning to evening (today/'s EVENING_FROM; a test keeps them equal). */
export const MORNING_UNTIL = 840;

export const hm = (m: number): string => `${String(Math.floor(m / 60) % 24).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

export interface Line {
  readonly nm: string;
  readonly sub: string;
}

/** Day and time: the boundary, the morning, the warm hours. Read-only for now. */
export function dayLines(s: Settings): readonly Line[] {
  const late = (s.boundary + 1440 - 210) % 1440;          // a lights-out 3½ hours before the boundary still counts
  return [
    { nm: `A day ends at ${hm(s.boundary)}`, sub: `so a ${hm(late)} lights out belongs to the day you were awake for` },
    { nm: `Morning until ${hm(MORNING_UNTIL)}`, sub: 'then Today switches to the evening' },
    { nm: 'Warm colours from 19:00', sub: 'cool again at 05:00' },
  ];
}

/** The check-ins that are set, earliest first. */
export function checkinLines(cues: Iterable<CueRecord>): readonly Line[] {
  const first = (c: CueRecord) => ('at' in c.times ? c.times.at[0] : c.times.from) ?? 0;
  return [...cues]
    .filter(c => c.kind === 'checkin' && c.enabled)
    .sort((a, b) => first(a) - first(b))
    .map(c => ({ nm: `${first(c) < MORNING_UNTIL ? 'Morning' : 'Evening'} · ${hm(first(c))}`, sub: c.private ? 'shows only "Daily Commit"' : `"${c.text}"` }));
}

const DOW = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MON = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** When a copy was made, on the home clock: "today, 13:20" or "Sunday 20 September, 14:02". */
export function whenWords(ms: number, nowMs: number, tz: string): string {
  const of = (t: number) => Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone: tz, year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(t).map(p => [p.type, p.value]));
  const p = of(ms);
  const n = of(nowMs);
  const time = `${p.hour}:${p.minute}`;
  if (p.year === n.year && p.month === n.month && p.day === n.day) return `today, ${time}`;
  const day = new Date(Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day)));
  return `${DOW[day.getUTCDay()]} ${day.getUTCDate()} ${MON[day.getUTCMonth()]}, ${time}`;
}

/** How a size reads: "2.4 MB", "640 KB". */
export function sizeWords(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

export const SETTINGS_WORDS = {
  noCheckins: 'No check-ins are set. Nothing reminds you to log unless a habit has its own reminder.',
  cues: { nm: 'Reminders for habits', sub: 'set inside each habit, in Plan. This one switch turns every one of them off' },
  cuesNote: 'Two check-ins a day at most, and each one only invites you to log. Nothing is ever repeated if you ignore it. On a locked phone a notification shows only "Daily Commit".',
  contrast: { nm: 'Contrast', sub: 'Lifts or lowers every panel and line at once. Try 70 at night and 110 in the morning.' },
  dim: { nm: 'Dim at night', sub: 'after 19:00 the whole app runs a little dimmer. Black stays exactly black' },
  auto: (when: string | undefined) => ({ nm: 'Saved automatically', sub: `a locked copy is made each time the app locks after a change. ${when ? `Last one: ${when}` : 'None made yet'}` }),
  android: { nm: "Carried by Android's backup", sub: 'to your Google account, about once a day. A new phone needs your Google sign-in and your passphrase' },
  export: { nm: 'Export a copy', sub: 'to a place you choose' },
  exported: { Saved: 'Saved where you chose.', Cancelled: 'Nothing was saved.', NoSave: "This device can't save a file.", Failed: "The copy couldn't be made. Nothing was changed." },
  restore: { nm: 'Restore from a backup', sub: 'replaces everything on this phone, after asking' },
  space: (size: string | undefined) => ({ nm: size ? `On this phone · ${size}` : 'On this phone', sub: "kept in the app's own storage. Android may clear it only if the phone runs out of space, and the saved copies cover that" }),
  dataNote: 'Every copy is locked. Without your passphrase or the recovery code, none of them can be read, by anyone.',
  pause: { nm: 'Pause tracking', sub: 'hides every habit, keeps the diary, deletes nothing, sends nothing' },
  pauseNote: 'It lives here from day one and the app never suggests it.',
  about: (version: string) => ({ nm: 'Daily Commit', sub: `a notebook, not a treatment · version ${version}` }),
  cant: [
    { nm: 'Copies made before a change', sub: 'still open with the passphrase that was in use when they were made' },
    { nm: 'When, not what', sub: 'the times things changed are readable, for example when a day was closed. What you wrote is not' },
    { nm: 'Erasing from memory', sub: "an app like this can't promise text is wiped from the phone's memory the instant it locks" },
  ] as readonly Line[],
  aboutNote: 'Said once, here.',
  opensOn: (wide: boolean) => `How Daily Commit opens on ${wide ? 'your phone' : 'this phone'}`,
  phoneLock: { nm: "Your phone's lock", sub: 'Fingerprint, or the PIN or pattern that unlocks your phone. Anyone who knows that PIN or pattern can open Daily Commit too.' },
  ownCode: { nm: 'A separate code, only for Daily Commit', sub: "Six digits or more, only for this app, and after 5 wrong tries only your passphrase opens it. It stops people. Against someone who can break into the phone's software it is weaker than your phone's lock; setting it up says how much." },
  finger: { nm: 'Fingerprint opens it too', sub: 'If anyone adds a new fingerprint to the phone, this switches itself off until you type your code.' },
  changeCode: { nm: 'Change the code', sub: 'six digits or more' },
  notVerified: { title: 'The separate code is off', text: "The new code couldn't be checked by the phone, so it wasn't kept. Your phone's lock and your passphrase still open Daily Commit. Set the code again whenever you like." },
  passAlways: "Your passphrase always works too. It's the only way in on a new phone, or after 5 wrong codes.",
  passOnly: 'Here only your passphrase opens Daily Commit. On the phone, its own lock or a code of your own can open it day to day.',
  locks: { nm: 'Locks the moment you leave', sub: "switching apps, or the screen going off. Picking a file or sharing from inside the app doesn't count" },
  changePass: { nm: 'Change passphrase', sub: 'your record stays as it is; only the lock on it changes' },
  checkCode: { nm: 'Check your recovery code', sub: 'type it from the paper' },
  newCode: { nm: 'Make a new recovery code', sub: 'if the paper is lost, or someone has seen it' },
  supportRow: { nm: 'Support', sub: 'always here, in the same place' },
} as const;
