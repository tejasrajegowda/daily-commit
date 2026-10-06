import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHabit, editHabit } from '../../src/record/ops/habits.ts';
import { cueForRules } from '../../src/record/mapping.ts';
import { changeOf, daysText, EMPTY_FORM, formOf, formProblems, newHabitOf, PLAN_WORDS, planLists, slotNote } from '../../src/plan/planView.ts';
import { freshDb } from '../record/helpers.ts';
import { dateOfDay, readState } from '../screens/harness/state.ts';
import { seedRecord } from '../screens/harness/seed.ts';

test('Focus is three slots and Log the rest; a full Focus says how something graduates', async () => {
  const { core } = await seedRecord(freshDb(), readState('#age=17&t=13:00'));
  const lists = planLists(core.session!.model, dateOfDay(17));
  assert.deepEqual(lists.focus.map(h => h?.name), ['Wake up', 'Walk', 'Practice']);
  assert.ok(lists.log.some(h => h.name === 'Read'));
  assert.match(slotNote(3), /^Full\./);
  assert.match(slotNote(2), /^A slot is free\./);
});

test('days read as words', () => {
  assert.equal(daysText([0, 1, 2, 3, 4, 5, 6]), 'every day');
  assert.equal(daysText([4, 0, 1, 2, 3]), 'Mon–Fri');
  assert.equal(daysText([5, 6]), 'weekends');
  assert.equal(daysText([0, 2]), 'M W');
});

test('the form says what is missing, in words, before anything is saved', () => {
  assert.deepEqual(formProblems({ ...EMPTY_FORM, name: 'Stretch' }), []);
  assert.deepEqual(formProblems(EMPTY_FORM), ['It needs a name.']);
  assert.ok(formProblems({ ...EMPTY_FORM, name: 'X', days: [] }).includes('Pick at least one day.'));
  assert.equal(formProblems({ ...EMPTY_FORM, name: 'X', kind: 'time', band: 420, part: 400 }).length, 1);
  assert.equal(formProblems({ ...EMPTY_FORM, name: 'X', kind: 'min', bar: 30, aim: 10 }).length, 1);
  assert.equal(formProblems({ ...EMPTY_FORM, name: 'X', kind: 'count', bar: 0 }).length, 1);
  assert.deepEqual(formProblems({ ...EMPTY_FORM, name: 'X', kind: 'count', bar: 3 }), []);
});

test('a count habit keeps its bar as the record\'s target, not a time band', () => {
  const form = { ...EMPTY_FORM, name: 'CANARY-TEST glasses of water', kind: 'count' as const, bar: 3 };
  assert.deepEqual(newHabitOf(form, 'h-new').target, { bar: 3 });
});

test('a new habit from the form is saved once; a fourth in Focus is refused', async () => {
  const { core } = await seedRecord(freshDb(), readState('#age=17&t=13:00'));
  const form = { ...EMPTY_FORM, name: 'CANARY-TEST stretch more', tier: 'focus' as const };
  const r = await createHabit(core, newHabitOf(form, 'h-new'));
  assert.equal(r.kind, 'Invalid');
  assert.equal((await createHabit(core, newHabitOf({ ...form, tier: 'log' }, 'h-new'))).kind, 'Saved');
});

test("an edit keeps the habit's kind, and a weekday change never reaches back before today", async () => {
  const { core } = await seedRecord(freshDb(), readState('#age=17&t=13:00'));
  const today = dateOfDay(17);
  const walk = core.session!.model.habits.get('h-walk')!;
  const form = { ...formOf(walk, today), kind: 'min' as const, days: [0, 1, 2, 3, 4] as const };
  assert.equal((await editHabit(core, changeOf({ ...form, days: [...form.days] }, walk))).kind, 'Saved');
  const after = core.session!.model.habits.get('h-walk')!;
  assert.equal(after.kind, 'tri');
  assert.equal(after.schedule.at(-1)?.from, today);
  assert.ok(after.schedule.length >= 2);
});

test('a private reminder reaches the rules with no words', () => {
  const cue = cueForRules({ id: 'c', habitId: 'h', kind: 'cue', text: 'CANARY-TEST words', times: { at: [420] }, enabled: true, createdOn: '2026-01-05', private: true } as never);
  assert.equal(cue.text, '');
});

test("Plan's words have no exclamation mark or percentage", () => {
  for (const w of Object.values(PLAN_WORDS)) assert.doesNotMatch(w, /[!%]/);
});
