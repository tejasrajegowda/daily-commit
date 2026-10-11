import { test } from 'node:test';
import assert from 'node:assert/strict';
import { againTo, HAND_OFF_WORDS, LEAVE_IT } from '../../src/app/handOffWords.ts';

test('R-3: each note says Android closed the app, what didn\'t happen, and offers both ways at the same weight', () => {
  for (const [kind, w] of Object.entries(HAND_OFF_WORDS)) {
    assert.match(w.text, /^Android closed Daily Commit while /, kind);
    for (const s of [w.title, w.text, w.again, LEAVE_IT]) assert.ok(!/[!%]/.test(s), `${kind}: ${s}`);
  }
  assert.deepEqual(againTo('export'), { screen: 'settings', variant: 'data' });
  assert.deepEqual(againTo('restore'), { screen: 'settings', variant: 'data' });
  assert.deepEqual(againTo('fingerprint'), { screen: 'settings', variant: 'privacy' });
  assert.deepEqual(againTo('restore-first'), { screen: 'restore', variant: '' });
});
