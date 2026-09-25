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

test('momentum needs a change of two days to move', () => {
  assert.equal(momentum(3, 5), 'building');
  assert.equal(momentum(5, 3), 'dipped');
  assert.equal(momentum(5, 6), 'strong');
  assert.equal(momentum(6, 5), 'strong');
  assert.equal(momentum(3, 4), 'steady');
  assert.equal(momentum(4, 4), 'steady');
});

test('small counts read as words', () => {
  assert.equal(countWord(0), 'no');
  assert.equal(countWord(8), 'eight');
  assert.equal(countWord(12), 'twelve');
  assert.equal(countWord(13), '13');
});
