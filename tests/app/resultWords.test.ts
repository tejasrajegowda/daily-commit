import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resultWords } from '../../src/app/resultWords.ts';
import { invalid, locked, quotaFull, saved, sealed } from '../../src/record/results.ts';

test('Saved needs no words', () => {
  assert.equal(resultWords(saved(undefined)), undefined);
});

test('every refused save has its own words, each saying it was not saved, with no ! or %', () => {
  const words = [sealed(), invalid('x'), quotaFull(), locked()].map(r => resultWords(r));
  const texts = words.map(w => `${w?.title} ${w?.text}`);
  assert.equal(new Set(texts).size, 4);
  for (const w of words) {
    assert.ok(w);
    assert.match(w.title, /^Not saved/);
    assert.doesNotMatch(`${w.title} ${w.text}`, /[!%]/);
  }
});

test('the phone being full, and a save that was not allowed, keep what was written', () => {
  assert.match(resultWords(quotaFull())?.text ?? '', /still here/);
  assert.match(resultWords(invalid('x'))?.text ?? '', /still here/);
});
