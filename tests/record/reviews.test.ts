import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reviewPeriod, saveReview } from '../../src/record/ops/reviews.ts';
import { openedRecord } from './helpers.ts';

test('a week review runs Monday to Sunday and a month review over its month; each is keyed by its start', async () => {
  assert.deepEqual(reviewPeriod('week', '2026-01-05'), { key: 'w:2026-01-05', end: '2026-01-11' });
  assert.equal(reviewPeriod('week', '2026-01-06'), undefined);
  assert.deepEqual(reviewPeriod('month', '2026-02-01'), { key: 'm:2026-02', end: '2026-02-28' });
  assert.deepEqual(reviewPeriod('month', '2026-12-01'), { key: 'm:2026-12', end: '2026-12-31' });
  assert.equal(reviewPeriod('month', '2026-02-03'), undefined);
  const { core } = await openedRecord();
  assert.equal((await saveReview(core, { period: 'week', start: '2026-01-05', answers: { went: 'CANARY-TEST' } })).kind, 'Saved');
  assert.equal((await saveReview(core, { period: 'week', start: '2026-01-05', answers: { went: 'CANARY-TEST' }, close: true })).kind, 'Saved');
  const review = core.session?.model.reviews.get('w:2026-01-05');
  assert.equal(review?.periodEnd, '2026-01-11');
  assert.ok(review?.closedAt !== undefined);
  assert.equal((await saveReview(core, { period: 'week', start: '2026-01-06', answers: {} })).kind, 'Invalid');
});
