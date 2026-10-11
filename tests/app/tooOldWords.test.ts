import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TOO_OLD_WORDS } from '../../src/app/tooOldWords.ts';

test('C10: the too-old screen is Task 0\'s four lines, and none has ! or %', () => {
  assert.equal(TOO_OLD_WORDS.title, 'This app is older than your record');
  assert.equal(TOO_OLD_WORDS.text, "Your record was saved by a newer version of Daily Commit, so this version can't open it. Nothing was opened or changed.");
  assert.equal(TOO_OLD_WORDS.fix, "Installing the newer version over this one brings everything back as it was. Uninstalling isn't needed, and would remove the record from this phone.");
  assert.equal(TOO_OLD_WORDS.version('0.1.0'), 'This phone has version 0.1.0.');
  for (const s of [TOO_OLD_WORDS.title, TOO_OLD_WORDS.text, TOO_OLD_WORDS.fix, TOO_OLD_WORDS.version('0.1.0')]) {
    assert.equal(/[!%]/.test(s), false, s);
  }
});
