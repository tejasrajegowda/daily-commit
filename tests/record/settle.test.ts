import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHabit, settleHabit } from '../../src/record/ops/habits.ts';
import { tierOn } from '../../src/rules/state.ts';
import { openedRecord } from './helpers.ts';

const WALK = { id: 'h-walk', name: 'CANARY-TEST walk', kind: 'tri', days: [0, 1, 2, 3, 4, 5, 6], asked: 'evening', target: {}, tier: 'focus', startedOn: '2026-01-05' } as const;

test('settling moves the habit to Log from tomorrow, keeps today in Focus, and records when', async () => {
  const { core, db } = await openedRecord('2026-01-05T09:00:00Z');
  await createHabit(core, WALK);
  assert.equal((await settleHabit(core, { id: 'h-walk' })).kind, 'Saved');
  const h = core.session!.model.habits.get('h-walk')!;
  assert.ok(h.settledAt);
  assert.equal(tierOn(h, '2026-01-05'), 'focus');
  assert.equal(tierOn(h, '2026-01-06'), 'log');
  assert.equal((await db.habits.get('h-walk'))?.updated_at, h.settledAt);
});

test('settling twice writes nothing the second time; an unknown habit is refused', async () => {
  const { core, db } = await openedRecord('2026-01-05T09:00:00Z');
  await createHabit(core, WALK);
  await settleHabit(core, { id: 'h-walk' });
  const before = await db.habits.get('h-walk');
  assert.equal((await settleHabit(core, { id: 'h-walk' })).kind, 'Saved');
  assert.deepEqual(await db.habits.get('h-walk'), before);
  assert.equal((await settleHabit(core, { id: 'nope' })).kind, 'Invalid');
});
