import { test } from 'node:test';
import assert from 'node:assert/strict';
import { restCounts, restDaysLeft, restOffered } from '../../src/rules/rest.ts';

test('two a calendar month, from the first day: none used leaves two', () => {
  assert.equal(restDaysLeft([], '2026-01-05'), 2);
});

test('counted per day, by the marked day\'s month: one used leaves one, two leave none, a new month starts again', () => {
  assert.equal(restDaysLeft(['2026-01-20'], '2026-01-25'), 1);
  assert.equal(restDaysLeft(['2026-01-20', '2026-01-20'], '2026-01-25'), 1);
  assert.equal(restDaysLeft(['2026-01-20', '2026-01-24'], '2026-01-25'), 0);
  assert.equal(restDaysLeft(['2026-01-20', '2026-01-24'], '2026-02-01'), 2);
});

test('a new mark counts when its day already counts or its month has one left', () => {
  assert.equal(restCounts(['2026-01-20', '2026-01-24'], '2026-01-24'), true);
  assert.equal(restCounts(['2026-01-20', '2026-01-24'], '2026-01-27'), false);
  assert.equal(restCounts(['2026-01-20'], '2026-01-27'), true);
  assert.equal(restCounts([], '2026-01-27'), true);
});

test('offered in the evening, for tomorrow, while tomorrow has one left and is not one already', () => {
  assert.equal(restOffered({ evening: true, left: 1, counted: false, already: false }), true);
  assert.equal(restOffered({ evening: false, left: 2, counted: false, already: false }), false);
  assert.equal(restOffered({ evening: true, left: 0, counted: false, already: false }), false);
  assert.equal(restOffered({ evening: true, left: 0, counted: true, already: false }), true);     // it uses none
  assert.equal(restOffered({ evening: true, left: 2, counted: false, already: true }), false);
});
