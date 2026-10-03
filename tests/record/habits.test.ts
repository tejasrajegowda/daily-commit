import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stateOf } from '../../src/rules/state.ts';
import { createHabit, editHabit, retireHabit, returnHabit, swapFocus, type NewHabit } from '../../src/record/ops/habits.ts';
import { logObservation } from '../../src/record/ops/observations.ts';
import { openedRecord } from './helpers.ts';

const walk = (over: Partial<NewHabit> = {}): NewHabit =>
  ({ id: 'h-walk', name: 'CANARY-TEST walk', kind: 'tri', days: [0, 1, 2, 3, 4, 5, 6], asked: 'evening', target: {}, tier: 'focus', ...over });
const stretch = { id: 'c-walk', text: 'Stand up and stretch', times: { every: 60, from: 420, to: 1320 }, private: false };

test('a habit is made with its reminders in one save, in memory and in storage', async () => {
  const { core, db } = await openedRecord();
  assert.equal((await createHabit(core, walk({ cues: [stretch] }))).kind, 'Saved');
  const h = core.session?.model.habits.get('h-walk');
  assert.deepEqual(h?.periods, [{ from: '2026-01-05' }]);
  assert.deepEqual(h?.schedule, [{ from: '2026-01-05', days: [0, 1, 2, 3, 4, 5, 6], asked: 'evening' }]);
  assert.equal(h?.order, 0);
  assert.equal(core.session?.model.cues.get('c-walk')?.createdOn, '2026-01-05');
  assert.equal(await db.habits.count(), 1);
  assert.equal(await db.cues.count(), 1);
});

test('Save tapped twice makes one habit and one reminder', async () => {
  const { core, db } = await openedRecord();
  const results = await Promise.all([createHabit(core, walk({ cues: [stretch] })), createHabit(core, walk({ cues: [stretch] }))]);
  assert.deepEqual(results.map(r => r.kind), ['Saved', 'Saved']);
  assert.equal(await db.habits.count(), 1);
  assert.equal(await db.cues.count(), 1);
  assert.equal(core.session?.model.habits.size, 1);
});

test('at most three habits are in Focus on any day', async () => {
  const { core } = await openedRecord();
  for (const id of ['a', 'b', 'c']) assert.equal((await createHabit(core, walk({ id }))).kind, 'Saved');
  assert.deepEqual(await createHabit(core, walk({ id: 'd' })), { kind: 'Invalid', reason: 'three habits are in Focus already' });
  assert.equal((await createHabit(core, walk({ id: 'd', tier: 'log' }))).kind, 'Saved');
  assert.equal((await swapFocus(core, { into: 'd' })).kind, 'Invalid');
  assert.equal((await swapFocus(core, { into: 'd', out: 'a' })).kind, 'Saved');
  assert.deepEqual(core.session?.model.habits.get('a')?.tierHistory, [{ tier: 'log', from: '2026-01-05' }]);   // a same-day change replaces
  assert.deepEqual(core.session?.model.habits.get('d')?.tierHistory, [{ tier: 'focus', from: '2026-01-05' }]);
});

test('a weekday change on a day already logged starts tomorrow, and earlier weeks keep their weekdays', async () => {
  const { core, clock } = await openedRecord();
  await createHabit(core, walk());
  clock.set('2026-01-14T20:00:00Z');                                       // a Wednesday
  assert.equal((await logObservation(core, { habitId: 'h-walk', date: '2026-01-14', value: 'did' })).kind, 'Saved');
  assert.equal((await editHabit(core, { id: 'h-walk', days: [5, 6] })).kind, 'Saved');      // weekends only
  const h = core.session?.model.habits.get('h-walk');
  assert.ok(h);
  assert.deepEqual(h.schedule.map(s => s.from), ['2026-01-05', '2026-01-15']);
  assert.equal(stateOf(h, { habitId: 'h-walk', date: '2026-01-14', value: 'did' }, '2026-01-14'), 'did');   // today's log still counts
  assert.equal(stateOf(h, undefined, '2026-01-07'), 'nothing');            // last Wednesday is still asked
  assert.equal(stateOf(h, undefined, '2026-01-21'), 'off');                // next Wednesday is not
});

test('a weekday change on a day not yet logged starts today; a second change that day replaces it', async () => {
  const { core, clock } = await openedRecord();
  await createHabit(core, walk());
  clock.set('2026-01-14T20:00:00Z');
  await editHabit(core, { id: 'h-walk', days: [0, 1, 2] });
  await editHabit(core, { id: 'h-walk', days: [3, 2, 1, 0] });
  assert.deepEqual(core.session?.model.habits.get('h-walk')?.schedule, [
    { from: '2026-01-05', days: [0, 1, 2, 3, 4, 5, 6], asked: 'evening' },
    { from: '2026-01-14', days: [0, 1, 2, 3], asked: 'evening' },
  ]);
  await editHabit(core, { id: 'h-walk', days: [0, 1, 2, 3, 4, 5, 6] });     // changed back the same day
  assert.equal(core.session?.model.habits.get('h-walk')?.schedule.length, 1);
});

test('retiring keeps today\'s log, and coming back the same day simply undoes it', async () => {
  const { core } = await openedRecord();
  await createHabit(core, walk());
  await logObservation(core, { habitId: 'h-walk', date: '2026-01-05', value: 'did' });
  assert.equal((await retireHabit(core, { id: 'h-walk' })).kind, 'Saved');
  const retired = core.session?.model.habits.get('h-walk');
  assert.ok(retired);
  assert.deepEqual(retired.periods, [{ from: '2026-01-05', until: '2026-01-06' }]);
  assert.equal(stateOf(retired, { habitId: 'h-walk', date: '2026-01-05', value: 'did' }, '2026-01-05'), 'did');
  assert.equal(stateOf(retired, undefined, '2026-01-06'), 'outside');
  assert.equal((await returnHabit(core, { id: 'h-walk' })).kind, 'Saved');
  assert.deepEqual(core.session?.model.habits.get('h-walk')?.periods, [{ from: '2026-01-05' }]);
});

test('coming back days later adds a new period; the days away are outside it, never overlapping', async () => {
  const { core, clock } = await openedRecord();
  await createHabit(core, walk());
  await retireHabit(core, { id: 'h-walk' });
  clock.set('2026-01-09T09:00:00Z');
  assert.equal((await returnHabit(core, { id: 'h-walk' })).kind, 'Saved');
  const h = core.session?.model.habits.get('h-walk');
  assert.ok(h);
  assert.deepEqual(h.periods, [{ from: '2026-01-05', until: '2026-01-06' }, { from: '2026-01-09' }]);
  assert.equal(stateOf(h, undefined, '2026-01-07'), 'outside');
  assert.deepEqual(await returnHabit(core, { id: 'h-walk' }), { kind: 'Invalid', reason: 'not retired' });
});

test('"started on" moves the first period, weekdays and tier back together, and never forward', async () => {
  const { core } = await openedRecord();
  await createHabit(core, walk());
  assert.equal((await editHabit(core, { id: 'h-walk', startedOn: '2025-12-01' })).kind, 'Saved');
  const h = core.session?.model.habits.get('h-walk');
  assert.deepEqual([h?.periods[0]?.from, h?.schedule[0]?.from, h?.tierHistory[0]?.from], ['2025-12-01', '2025-12-01', '2025-12-01']);
  assert.equal((await editHabit(core, { id: 'h-walk', startedOn: '2026-01-06' })).kind, 'Invalid');
});

test('a habit that makes no sense is refused, and nothing is stored', async () => {
  const { core, db } = await openedRecord();
  const bad: NewHabit[] = [
    walk({ name: '  ' }),
    walk({ days: [] }),
    walk({ days: [7] as unknown as NewHabit['days'] }),
    walk({ kind: 'time', target: { band: 1500, part: 1400 } }),
    walk({ target: { bar: 3 } }),
    walk({ startedOn: '2026-02-01' }),
    walk({ cues: [{ ...stretch, times: { every: 60, from: 180, to: 300 } }] }),     // a range across 04:00
  ];
  for (const h of bad) assert.equal((await createHabit(core, h)).kind, 'Invalid', JSON.stringify(h));
  assert.equal(await db.habits.count(), 0);
});

test('Focus never holds more than three habits in the plan on any day: retiring, returning and backdating included', async () => {
  const { core, clock } = await openedRecord();                                 // Monday 2026-01-05
  for (const id of ['h-a', 'h-b', 'h-c']) assert.equal((await createHabit(core, walk({ id }))).kind, 'Saved');
  assert.equal((await retireHabit(core, { id: 'h-a' })).kind, 'Saved');         // still in the plan today
  assert.equal((await createHabit(core, walk({ id: 'h-d' }))).kind, 'Invalid', 'a retiring habit still counts today');
  clock.set('2026-01-08T09:00:00Z');                                            // h-a is out of the plan now
  assert.equal((await createHabit(core, walk({ id: 'h-d' }))).kind, 'Saved');
  assert.equal((await returnHabit(core, { id: 'h-a' })).kind, 'Invalid', 'coming back in Focus would make four');
  assert.equal((await createHabit(core, walk({ id: 'h-e', tier: 'log', startedOn: '2026-01-05' }))).kind, 'Saved');
  assert.equal((await createHabit(core, walk({ id: 'h-f', startedOn: '2026-01-05' }))).kind, 'Invalid', 'a backdated Focus habit would make four on past days');
  assert.equal((await editHabit(core, { id: 'h-d', startedOn: '2026-01-05' })).kind, 'Invalid', 'moving a Focus habit\'s start earlier would make four');
});