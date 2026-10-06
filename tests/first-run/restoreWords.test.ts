import { test } from 'node:test';
import assert from 'node:assert/strict';
import { madeAtWords, RESTORE_WORDS, STOP_WORDS } from '../../src/first-run/restoreWords.ts';

test('the seven messages are all different, and none has ! or %', () => {
  const all = Object.values(RESTORE_WORDS).map(w => `${w.title} ${w.text}`);
  assert.equal(new Set(all).size, 7);
  for (const t of all) assert.doesNotMatch(t, /[!%]/);
});

test('a wrong passphrase points to the recovery code, since a damaged copy of it looks the same', () => {
  assert.match(RESTORE_WORDS.wrong.text, /recovery code/);
});

test('newer, damaged, full and not-a-backup each say nothing on this phone was changed', () => {
  for (const m of ['newer', 'damaged', 'full', 'not-backup'] as const) assert.match(RESTORE_WORDS[m].text, /nothing on this phone was changed/i);
});

test("a restore that stopped before it finished promises nothing it can't know about the phone", () => {
  assert.doesNotMatch(RESTORE_WORDS['not-finished'].text, /nothing on this phone was changed/i);
  assert.doesNotMatch(STOP_WORDS['not-finished'].text, /nothing on this phone was changed|as it was/i);
});

test("a replace that stopped says it's locked now and to open it, never to try again from here; all differ, none has ! or %", () => {
  const all = Object.values(STOP_WORDS);
  assert.equal(new Set(all.map(w => `${w.title} ${w.text}`)).size, 3);
  for (const w of all) {
    assert.match(w.text, /Daily Commit is locked now/);
    assert.match(w.text, /open it/i);
    assert.doesNotMatch(w.text, /try again/i);
    assert.doesNotMatch(`${w.title} ${w.text}`, /[!%]/);
  }
  for (const m of ['full', 'not-saved'] as const) assert.match(STOP_WORDS[m].text, /nothing was replaced/i);
});

test('a file from another record says so', () => {
  assert.match(`${RESTORE_WORDS.other.title} ${RESTORE_WORDS.other.text}`, /different record/);
});

test('when a backup was made reads as weekday, day, month and 24-hour time, in the timezone given', () => {
  assert.equal(madeAtWords(Date.UTC(2026, 0, 11, 14, 2), 'UTC'), 'Sunday 11 January, 14:02');
  assert.equal(madeAtWords(Date.UTC(2026, 0, 11, 23, 30), 'Asia/Tokyo'), 'Monday 12 January, 08:30');
});
