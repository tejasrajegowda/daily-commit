import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NOTE_WORDS, lockActions, noteFor } from '../../src/app/lockNotes.ts';
import type { LockMachine, UnlockOutcome } from '../../src/app/lockMachine.ts';

test('a wrong passphrase or recovery code says so', () => {
  assert.equal(noteFor('passphrase', { kind: 'WrongSecret' }), 'wrong-secret');
  assert.equal(noteFor('recovery', { kind: 'WrongSecret' }), 'wrong-secret');
});

test('a wrong own code says so, without a count', () => {
  assert.equal(noteFor('own-code', { kind: 'WrongCode', triesLeft: 2 }), 'wrong-code');
  assert.doesNotMatch(NOTE_WORDS['wrong-code'].text, /\d/);
});

test('the code gone after wrong codes says five wrong codes; gone without them says only that the way is off', () => {
  assert.equal(noteFor('own-code', { kind: 'CopyGone', offered: [] }, { kind: 'WrongCode', triesLeft: 1 }), 'code-off');
  assert.equal(noteFor('own-code', { kind: 'CopyGone', offered: [] }), 'mode-off');
  assert.equal(noteFor('phone-lock', { kind: 'CopyGone', offered: [] }), 'mode-off');
});

test('the fingerprint gone while the code still opens it says a new fingerprint was added', () => {
  assert.equal(noteFor('fingerprint', { kind: 'CopyGone', offered: ['own-code'] }), 'new-fingerprint');
});

test('a record that refuses to open says newer version or damaged', () => {
  assert.equal(noteFor('passphrase', { kind: 'Refused', reason: 'newer-app' }), 'newer-app');
  assert.equal(noteFor('passphrase', { kind: 'Refused', reason: 'damaged' }), 'damaged');
  assert.equal(noteFor('passphrase', { kind: 'Refused', reason: 'other-vault' }), 'damaged');
});

test('opening, backing out of the phone prompt, leaving, or not being locked say nothing', () => {
  for (const kind of ['Open', 'Cancelled', 'Left', 'NotLocked'] as const) assert.equal(noteFor('phone-lock', { kind }), undefined);
});

test('no note has an exclamation mark or a percentage', () => {
  for (const w of Object.values(NOTE_WORDS)) assert.doesNotMatch(`${w.title ?? ''} ${w.text}`, /[!%]/);
});

/** A machine whose unlock answers from a list. */
function scripted(outcomes: UnlockOutcome[]): LockMachine {
  return { unlock: async () => outcomes.shift() ?? { kind: 'Open' } } as unknown as LockMachine;
}

test('the actions keep the note of the last unlock, clear it when the next starts, and remember a wrong code for the fifth', async () => {
  const actions = lockActions(scripted([{ kind: 'WrongCode', triesLeft: 1 }, { kind: 'CopyGone', offered: [] }, { kind: 'Open' }]));
  let heard = 0;
  actions.subscribe(() => { heard++; });
  await actions.unlock({ mode: 'own-code', code: '00000000' });
  assert.equal(actions.note(), 'wrong-code');
  await actions.unlock({ mode: 'own-code', code: '00000000' });
  assert.equal(actions.note(), 'code-off');
  await actions.unlock({ method: 'passphrase', text: 'CANARY passphrase' });
  assert.equal(actions.note(), undefined);
  assert.ok(heard >= 3);
});
