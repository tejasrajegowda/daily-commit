import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rulesInput } from '../../src/record/read.ts';
import { saveReview } from '../../src/record/ops/reviews.ts';
import { lastWeek, monthView, togetherWords, weekView } from '../../src/reviews/reviewView.ts';
import type { HabitRecord } from '../../src/record/model.ts';
import { monthDue } from '../../src/app/reviewsDue.ts';
import { freshDb } from '../record/helpers.ts';
import { dateOfDay, readState } from '../screens/harness/state.ts';
import { seedRecord } from '../screens/harness/seed.ts';

async function at(day: number) {
  const { core } = await seedRecord(freshDb(), readState(`#age=${day}&t=10:30`));
  const model = core.session!.model;
  return { core, model, input: rulesInput(model), today: dateOfDay(day) };
}

test('the last week is the Monday to Sunday that finished before today', () => {
  assert.deepEqual(lastWeek('2026-01-21'), { monday: '2026-01-12', sunday: '2026-01-18' });
  assert.deepEqual(lastWeek('2026-01-19'), { monday: '2026-01-12', sunday: '2026-01-18' });   // a Monday
  assert.deepEqual(lastWeek('2026-01-18'), { monday: '2026-01-05', sunday: '2026-01-11' });   // a Sunday
});

test('in the first week nothing is said yet; after it, each row has its words', async () => {
  const early = await at(5);
  const e = weekView(early.input, early.model, early.today);
  assert.equal(e.empty, true);
  assert.ok(e.focus.every(r => r.words === undefined));
  const later = await at(17);
  const v = weekView(later.input, later.model, later.today);
  assert.equal(v.empty, false);
  assert.equal(v.monday, '2026-01-12');
  assert.equal(v.weekNumber, 2);
  assert.deepEqual(v.focus.map(r => r.habit.name), ['Wake up', 'Walk', 'Practice']);
  for (const r of [...v.focus, ...v.log]) assert.ok(r.words === undefined || ['most days', 'about half', 'a few days'].includes(r.words));
  assert.ok(v.focus.some(r => r.momentum !== undefined));
  assert.ok(v.log.every(r => r.momentum === undefined));
});

test('the monthly review opens on day 60 and covers the month before', async () => {
  const early = await at(40);
  assert.equal(monthView(early.input, early.model, early.today).open, false);
  const m = await at(60);
  const v = monthView(m.input, m.model, m.today);
  assert.equal(v.open, true);
  assert.equal(v.name, 'February');
  assert.equal(v.from, '2026-02-01');
  assert.equal(v.to, '2026-02-28');
  assert.equal(v.rows.length, 3);
  for (const s of [...v.rows.map(r => r.words), ...v.together]) assert.doesNotMatch(s, /[!%\d]{2,}%|!/);
});

test('the review is due in the first week of a month from day 60, until it is closed', async () => {
  const m = await at(60);                                    // 5 March
  assert.equal(monthDue(m.model, m.today), true);
  await saveReview(m.core, { period: 'month', start: '2026-02-01', answers: {}, close: true });
  assert.equal(monthDue(m.model, m.today), false);
  const late = await at(68);                                 // 13 March
  assert.equal(monthDue(late.model, late.today), false);
});

test('what went well together reads as a sentence whatever the habits are called', () => {
  const h = (id: string, name: string, kind: HabitRecord['kind']) => [id, { id, name, kind } as HabitRecord] as const;
  const byId = new Map([h('a', 'Ate well', 'tri'), h('b', 'Walk', 'tri'), h('c', 'Read', 'min'), h('d', 'Up', 'time'), h('e', 'Mood', 'mood')]);
  const said = (then: string, withValue = 1, withoutValue = 0) =>
    togetherWords({ when: 'a', then, withDays: 10, withoutDays: 10, withValue, withoutValue }, byId);
  assert.equal(said('b'), 'On the days ate well was done, walk was done more often than on the other days.');
  assert.equal(said('c', 40, 20), 'On the days ate well was done, read ran longer — about 40m, against 20m on the other days.');
  assert.equal(said('d', 400, 430), 'On the days ate well was done, up came earlier — about 06:40, against 07:10 on the other days.');
  assert.equal(said('e', 4, 3), 'On the days ate well was done, mood was higher on more of the evenings.');
  assert.equal(said('missing'), '');
});
