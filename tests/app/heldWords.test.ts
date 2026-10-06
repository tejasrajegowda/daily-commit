import { test } from 'node:test';
import assert from 'node:assert/strict';
import { heldWords } from '../../src/app/heldWords.ts';
import { resultWords } from '../../src/app/resultWords.ts';
import { invalid, locked, quotaFull, saved, type Result } from '../../src/record/results.ts';

/** A write that answers when told to. */
function later() {
  let answer: (r: Result<unknown>) => void = () => {};
  const write = () => new Promise<Result<unknown>>(done => { answer = done; });
  return { write, answer: (r: Result<unknown>) => answer(r) };
}

test('a refused save holds the words, with the words for why', async () => {
  const held = heldWords();
  assert.equal(await held.keep('diary:a', 'CANARY page', async () => quotaFull()), false);
  assert.deepEqual(held.get('diary:a'), { text: 'CANARY page', note: resultWords(quotaFull()) });
  assert.equal(held.get('diary:b'), undefined);
});

test('a write that throws holds the words too, and says they were not saved', async () => {
  const held = heldWords();
  await held.keep('notyet:new', 'CANARY later', () => Promise.reject(new Error('CANARY-TEST')));
  assert.equal(held.get('notyet:new')?.text, 'CANARY later');
  assert.match(held.get('notyet:new')?.note.title ?? '', /^Not saved/);
});

test('a save that goes through lets go of what was held', async () => {
  const held = heldWords();
  await held.keep('diary:a', 'CANARY page', async () => invalid('in the trash'));
  assert.ok(held.get('diary:a'));
  assert.equal(await held.keep('diary:a', 'CANARY page', async () => saved(undefined)), true);
  assert.equal(held.get('diary:a'), undefined);
});

test('words held under one key are untouched by another key', async () => {
  const held = heldWords();
  await held.keep('week:2026-01-05:line', 'CANARY line', async () => quotaFull());
  await held.keep('week:2026-01-05:changed', 'CANARY changed', async () => saved(undefined));
  assert.equal(held.get('week:2026-01-05:line')?.text, 'CANARY line');
});

test('an older answer arriving after newer words went out is not heard', async () => {
  const held = heldWords();
  const first = later(), second = later();
  const a = held.keep('diary:a', 'CANARY one', first.write);
  const b = held.keep('diary:a', 'CANARY one and two', second.write);
  second.answer(saved(undefined));
  await b;
  first.answer(quotaFull());
  await a;
  assert.equal(held.get('diary:a'), undefined);
});

test('a lock drops everything held, and an answer still on its way is not heard after it', async () => {
  const held = heldWords();
  await held.keep('support:badNightNote', 'CANARY note', async () => quotaFull());
  const pending = later();
  const p = held.keep('diary:a', 'CANARY page', pending.write);
  held.clear();
  assert.equal(held.get('support:badNightNote'), undefined);
  pending.answer(quotaFull());
  await p;
  assert.equal(held.get('diary:a'), undefined);
});

test('a save refused because the record locked holds nothing', async () => {
  const held = heldWords();
  await held.keep('diary:a', 'CANARY page', async () => locked());
  assert.equal(held.get('diary:a'), undefined);
});

test('drop lets go of the words, and the screens hear each change', async () => {
  const held = heldWords();
  let heard = 0;
  const stop = held.subscribe(() => { heard += 1; });
  await held.keep('diary:a', 'CANARY page', async () => quotaFull());
  held.drop('diary:a');
  held.drop('diary:a');
  assert.equal(held.get('diary:a'), undefined);
  assert.equal(heard, 2);
  stop();
  await held.keep('diary:a', 'CANARY page', async () => quotaFull());
  assert.equal(heard, 2);
});
