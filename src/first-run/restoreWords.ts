import type { RestoreMessage, StopMessage } from '../app/context.ts';

// What restore says. Each says what happened and, where that is known, that nothing on this phone
// was changed. None is coloured. `other` is shown beside the "Replace everything?" question; `other-record` is the
// message when a wrong secret turns out to belong to a different record than this phone's own.

const OTHER_RECORD = { title: 'A different record', text: "This backup was made from a different record. It opens only with the passphrase that was in use when it was made, which may not be today's." };

export const RESTORE_WORDS: Readonly<Record<RestoreMessage | 'other', { readonly title: string; readonly text: string }>> = {
  wrong: { title: "That didn't open it", text: "Check the passphrase. If you're sure it's right, this file's copy of it may be damaged, and the recovery code opens the file instead." },
  newer: { title: 'Made by a newer version', text: 'This backup was made by a newer version of Daily Commit. Update the app, then restore it. Nothing on this phone was changed.' },
  damaged: { title: 'This file is damaged', text: "It can't be restored. Nothing on this phone was changed. An older backup may still open." },
  'not-backup': { title: "This isn't a Daily Commit backup", text: 'Choose a backup file that Daily Commit made. Nothing on this phone was changed.' },
  full: { title: 'The phone is full', text: 'Nothing was restored, and nothing on this phone was changed. Free some space and try again.' },
  'not-finished': { title: 'Not finished', text: 'The restore stopped before it finished. Try again. If it stops again, an older backup may still open.' },
  'not-replaced': { title: 'Not replaced', text: 'The restore stopped before anything was replaced. The record on this phone is as it was. Try again.' },
  other: OTHER_RECORD,
  'other-record': OTHER_RECORD,
};

// A "Replace everything" that didn't happen. The keys were put away for the copy of what's here
// now, so Daily Commit is locked: the words say so, and the screen's one way on is the lock screen.
// None says "try again" here, since a second try from this screen can't work.
export const STOP_WORDS: Readonly<Record<StopMessage, { readonly title: string; readonly text: string }>> = {
  full: { title: 'The phone is full', text: 'Nothing was replaced, and your record is as it was. Daily Commit is locked now. Free some space, open it, then restore again.' },
  'not-saved': { title: 'Not replaced', text: "The copy of what's here now couldn't be saved first, so nothing was replaced. Your record is as it was. Daily Commit is locked now. Open it, then restore again." },
  'not-finished': { title: 'Not finished', text: 'The restore stopped before it finished. Daily Commit is locked now. Open it and look over your record before restoring again.' },
};

const DOW = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MON = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** When a backup was made, as the screens say it: "Sunday 20 September, 14:02", in the given timezone. */
export function madeAtWords(ms: number, tz: string): string {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone: tz, year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(ms).map(p => [p.type, p.value]));
  const day = new Date(Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day)));
  return `${DOW[day.getUTCDay()]} ${day.getUTCDate()} ${MON[day.getUTCMonth()]}, ${parts.hour}:${parts.minute}`;
}
