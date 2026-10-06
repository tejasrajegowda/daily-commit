import { test } from 'node:test';
import assert from 'node:assert/strict';
import { draft } from '../../src/today/draft.ts';

/** A save that answers when told to, recording what it was sent. */
function saver() {
  const sent: string[] = [];
  const answers: ((ok: boolean) => void)[] = [];
  const save = (text: string) => {
    sent.push(text);
    return new Promise<boolean>(done => { answers.push(done); });
  };
  const answer = async (ok: boolean) => {
    answers.shift()?.(ok);
    await new Promise(done => setImmediate(done));
  };
  return { sent, save, answer };
}

test('words still in the field when it goes away are saved', async () => {
  const s = saver();
  const lost: string[] = [];
  const d = draft('', s.save, t => lost.push(t));
  d.open();
  d.type('A slow walk');
  d.close();
  assert.deepEqual(s.sent, ['A slow walk']);
  await s.answer(true);
  assert.deepEqual(lost, []);
});

test('nothing is sent when the words are the ones the record holds', () => {
  const s = saver();
  const d = draft('Read a chapter', s.save, () => {});
  d.open();
  d.flush();
  d.type('Read a chapter');
  d.close();
  assert.deepEqual(s.sent, []);
});

test('a blur, then the field going away, sends the same words once', async () => {
  const s = saver();
  const d = draft('', s.save, () => {});
  d.open();
  d.type('Walk');
  d.flush();
  d.close();
  assert.deepEqual(s.sent, ['Walk']);
  await s.answer(true);
});

test('a save that fails while the field is there is tried again on the next blur, and nothing is lost', async () => {
  const s = saver();
  const lost: string[] = [];
  const d = draft('', s.save, t => lost.push(t));
  d.open();
  d.type('Walk');
  d.flush();
  await s.answer(false);
  assert.deepEqual(lost, []);
  d.flush();
  assert.deepEqual(s.sent, ['Walk', 'Walk']);
  await s.answer(true);
});

test('a save that fails after the field went away hands the words over', async () => {
  const s = saver();
  const lost: string[] = [];
  const d = draft('', s.save, t => lost.push(t));
  d.open();
  d.type('Walk at noon');
  d.close();
  await s.answer(false);
  assert.deepEqual(lost, ['Walk at noon']);
});

test('a save already on its way when the field goes, and then failing, hands the words over too', async () => {
  const s = saver();
  const lost: string[] = [];
  const d = draft('', s.save, t => lost.push(t));
  d.open();
  d.type('Walk');
  d.flush();
  d.close();
  assert.deepEqual(s.sent, ['Walk']);
  await s.answer(false);
  assert.deepEqual(lost, ['Walk']);
});

test('a save that throws counts as failed', async () => {
  const lost: string[] = [];
  const d = draft('', () => Promise.reject(new Error('CANARY-TEST')), t => lost.push(t));
  d.open();
  d.type('Walk');
  d.close();
  await new Promise(done => setImmediate(done));
  assert.deepEqual(lost, ['Walk']);
});

test('an older save failing after newer words went out changes nothing', async () => {
  const s = saver();
  const lost: string[] = [];
  const d = draft('', s.save, t => lost.push(t));
  d.open();
  d.type('Walk');
  d.flush();
  d.type('Walk and read');
  d.close();
  assert.deepEqual(s.sent, ['Walk', 'Walk and read']);
  await s.answer(false);
  assert.deepEqual(lost, []);
  await s.answer(true);
  assert.deepEqual(lost, []);
});

test('words kept from before start in the field and are saved, though nothing new is typed', async () => {
  const s = saver();
  const d = draft('', s.save, () => {});
  d.open();
  d.flush();
  assert.deepEqual(s.sent, []);
  const kept = draft('', s.save, () => {}, 'Walk');
  kept.open();
  kept.flush();
  assert.deepEqual(s.sent, ['Walk']);
  await s.answer(true);
});

test('a field drawn again after a trial removal (as React does in development) is not treated as gone', async () => {
  const s = saver();
  const lost: string[] = [];
  const d = draft('', s.save, t => lost.push(t));
  d.open();
  d.close();
  d.open();
  d.type('Walk');
  d.flush();
  await s.answer(false);
  assert.deepEqual(lost, []);
});
