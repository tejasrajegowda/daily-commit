import { test } from 'node:test';
import assert from 'node:assert/strict';
import { restDaysLeft, restOffered } from '../../src/rules/rest.ts';

const START = '2026-01-05';

test('no rest day before day 14', () => {
  assert.equal(restDaysLeft([], '2026-01-17', START), 0);       // day 13
  assert.equal(restDaysLeft([], '2026-01-18', START), 2);       // day 14
});

test('two in a calendar month: one used leaves one, two used leave none, and a new month starts again', () => {
  assert.equal(restDaysLeft(['2026-01-20'], '2026-01-25', START), 1);
  assert.equal(restDaysLeft(['2026-01-20', '2026-01-24'], '2026-01-25', START), 0);
  assert.equal(restDaysLeft(['2026-01-20', '2026-01-24'], '2026-02-01', START), 2);
});

test('offered only in the evening, only with something in Focus still open, and only with one left', () => {
  assert.equal(restOffered({ evening: true, openFocus: 1, left: 1 }), true);
  assert.equal(restOffered({ evening: false, openFocus: 2, left: 2 }), false);
  assert.equal(restOffered({ evening: true, openFocus: 0, left: 2 }), false);
  assert.equal(restOffered({ evening: true, openFocus: 2, left: 0 }), false);
});
