import { test } from 'node:test';
import assert from 'node:assert/strict';
import { answering, isSilent, PHONE_ANSWER_MS } from '../../src/app/phoneAnswer.ts';
import { fakePlugin } from '../vault/fakePlugin.ts';

test('the give-up is 15 seconds, on the calls that need no one\'s finger', async () => {
  assert.equal(PHONE_ANSWER_MS, 15_000);
  const p = answering({ ...fakePlugin().plugin, status: () => new Promise(() => {}), verifyCode: () => new Promise(() => {}) }, 20);
  await assert.rejects(p.status(), e => isSilent(e));
  await assert.rejects(p.verifyCode('000000'), e => isSilent(e));
});

test('an answer in time is the answer, and no timer is left behind', async () => {
  const p = answering(fakePlugin().plugin, 60_000);
  assert.deepEqual(await p.status(), { modes: [] });                     // the test would hang a minute if the timer stayed
});

test('the phone\'s own prompt has no give-up: the person is in it', async () => {
  let resolve!: (v: { kind: 'Cancelled' }) => void;
  const p = answering({ ...fakePlugin().plugin, unwrap: () => new Promise(r => { resolve = r; }) }, 10);
  const opening = p.unwrap('phone-lock');
  await new Promise(r => setTimeout(r, 30));
  resolve({ kind: 'Cancelled' });
  assert.deepEqual(await opening, { kind: 'Cancelled' });
});
