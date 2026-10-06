import { test } from 'node:test';
import assert from 'node:assert/strict';
import { madeAtWords, RESTORE_WORDS } from '../../src/first-run/restoreWords.ts';

test('the six messages are all different, and none has ! or %', () => {
  const all = Object.values(RESTORE_WORDS).map(w => `${w.title} ${w.text}`);
  assert.equal(new Set(all).size, 6);
  for (const t of all) assert.doesNotMatch(t, /[!%]/);
});

test('a wrong passphrase points to the recovery code, since a damaged copy of it looks the same', () => {
  assert.match(RESTORE_WORDS.wrong.text, /recovery code/);
});

test('newer, damaged, full and not-a-backup each say nothing on this phone was changed', () => {
  for (const m of ['newer', 'damaged', 'full', 'not-backup'] as const) assert.match(RESTORE_WORDS[m].text, /nothing on this phone was changed/i);
});

test('a file from another record says so', () => {
  assert.match(`${RESTORE_WORDS.other.title} ${RESTORE_WORDS.other.text}`, /different record/);
});

test('when a backup was made reads as weekday, day, month and 24-hour time, in the timezone given', () => {
  assert.equal(madeAtWords(Date.UTC(2026, 0, 11, 14, 2), 'UTC'), 'Sunday 11 January, 14:02');
  assert.equal(madeAtWords(Date.UTC(2026, 0, 11, 23, 30), 'Asia/Tokyo'), 'Monday 12 January, 08:30');
});
