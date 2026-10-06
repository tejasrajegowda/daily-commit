import { test } from 'node:test';
import assert from 'node:assert/strict';
import { band, bandWords, countWord, momentum } from '../../src/rules/words.ts';

test('bands follow "7 in 10" and "4 in 10" exactly', () => {
  assert.equal(band(7, 10), 'most');
  assert.equal(band(5, 7), 'most');            // 71 in 100
  assert.equal(band(69, 100), 'half');
  assert.equal(band(4, 10), 'half');
  assert.equal(band(2, 5), 'half');
  assert.equal(band(39, 100), 'few');
  assert.equal(band(1, 7), 'few');
  assert.equal(band(0, 7), null);
  assert.equal(band(0, 0), null);
});

test('band words differ only in how a week and a month are said', () => {
  assert.equal(bandWords('half', 'week'), 'about half');
  assert.equal(bandWords('half', 'month'), 'about half the days');
  assert.equal(bandWords(null, 'week'), 'a quiet week');
  assert.equal(bandWords(null, 'month'), 'a quiet month');
});

const wk = (done: number, asked = 7) => ({ done, asked });

test('momentum needs a change of two days to move', () => {
  assert.equal(momentum(wk(3), wk(5)), 'building');
  assert.equal(momentum(wk(5), wk(3)), 'dipped');
  assert.equal(momentum(wk(5), wk(6)), 'strong');
  assert.equal(momentum(wk(6), wk(5)), 'strong');
  assert.equal(momentum(wk(3), wk(4)), 'steady');
  assert.equal(momentum(wk(4), wk(4)), 'steady');
});

test("momentum compares rates, not raw counts: planned rest days never read as a dip (R3-7)", () => {
  // Walk done every day it was asked, both weeks; this week had two fewer asked days (planned
  // rest). The rate held at full pace, so it reads "strong", never "dipped".
  assert.equal(momentum(wk(7, 7), wk(5, 5)), 'strong');
  // A habit's days were reduced in Plan (B-3): fewer asked, same (lower) rate, still steady.
  assert.equal(momentum(wk(3, 5), wk(2, 3)), 'steady');
  // A real dip still reads as one: fewer done out of the same asked days.
  assert.equal(momentum(wk(7, 7), wk(5, 7)), 'dipped');
});

test('small counts read as words', () => {
  assert.equal(countWord(0), 'no');
  assert.equal(countWord(8), 'eight');
  assert.equal(countWord(12), 'twelve');
  assert.equal(countWord(13), '13');
});
