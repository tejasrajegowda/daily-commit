import { test } from 'node:test';
import assert from 'node:assert/strict';
import { meter } from '../../src/first-run/meter.ts';

test('under 15 characters is never more than two bars, and says the minimum', () => {
  assert.deepEqual(meter(''), { bars: 0, label: 'At least 15 characters' });
  assert.deepEqual(meter('red fox'), { bars: 2, label: 'At least 15 characters' });
  assert.ok(meter('a b c d e f g').bars <= 2);
});

test('15 characters or more counts words, and four words or 24 characters is strong', () => {
  assert.deepEqual(meter('correcthorsebat'), { bars: 1, label: 'Long enough' });
  assert.deepEqual(meter('river stone lamp'), { bars: 3, label: 'Long enough' });
  assert.deepEqual(meter('river stone lamp cloud'), { bars: 4, label: 'Strong' });
  assert.deepEqual(meter('river stone lamp cloud paper wind'), { bars: 5, label: 'Strong' });
  assert.equal(meter('abcdefghijklmnopqrstuvwxyz').label, 'Strong');
});

test('the length is counted after the same normalisation the lock uses', () => {
  assert.equal(meter('   river stone lamp   ').label, 'Long enough');
  assert.equal(meter('é'.repeat(14) + 'x').label, 'Long enough');
  assert.equal(meter('é'.repeat(13) + 'x').label, 'At least 15 characters');
});

test('the labels have no exclamation mark or percentage', () => {
  for (const text of ['', 'river stone lamp', 'river stone lamp cloud']) assert.doesNotMatch(meter(text).label, /[!%]/);
});
