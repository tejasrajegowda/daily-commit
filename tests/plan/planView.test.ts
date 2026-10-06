import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHabit, editHabit } from '../../src/record/ops/habits.ts';
import { cueForRules } from '../../src/record/mapping.ts';
import { changeOf, daysText, EMPTY_FORM, formOf, formProblems, newHabitOf, PLAN_WORDS, planLists, slotNote } from '../../src/plan/planView.ts';
import { stateOf } from '../../src/rules/state.ts';
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

test('a time habit asked at night keeps a band after midnight on its night, so 22:30 and 00:15 count as done by 00:30', async () => {
  const { core } = await seedRecord(freshDb(), readState('#age=17&t=13:00'));
  const today = dateOfDay(17);
  const form = { ...EMPTY_FORM, name: 'In bed', kind: 'time' as const, asked: 'evening' as const, band: 30 };
  assert.deepEqual(newHabitOf(form, 'h-bed').target, { band: 1470 });
  assert.equal((await createHabit(core, newHabitOf(form, 'h-bed'))).kind, 'Saved');
  const bed = core.session!.model.habits.get('h-bed')!;
  const on = (value: number) => stateOf(bed, { habitId: 'h-bed', date: today, value }, today);
  assert.equal(on(1350), 'did');      // 22:30
  assert.equal(on(1455), 'did');      // 00:15
  assert.equal(on(1470), 'did');      // 00:30
  assert.equal(on(1500), 'nothing');  // 01:00
  // the editor shows it back as 00:30, and saving it again keeps it on the same night
  const again = formOf(bed, today);
  assert.equal(again.band, 30);
  assert.deepEqual(changeOf(again, bed).target, { band: 1470 });
});

test("a band before midnight is kept as typed, the boundary from Settings is used, and a morning band stays in the morning", () => {
  const night = { ...EMPTY_FORM, name: 'In bed', kind: 'time' as const, asked: 'evening' as const };
  assert.deepEqual(newHabitOf({ ...night, band: 1410 }, 'h').target, { band: 1410 });
  assert.deepEqual(newHabitOf({ ...night, band: 30 }, 'h', 120).target, { band: 1470 });  // a 02:00 boundary: 00:30 is before it, so the night before
  assert.deepEqual(newHabitOf({ ...night, band: 150 }, 'h', 120).target, { band: 150 });  // ...and 02:30 is after it
  assert.deepEqual(newHabitOf({ ...night, asked: 'morning', band: 230 }, 'h').target, { band: 230 });
});

test('partly is checked on the same night as done, so 23:30 then 00:30 is allowed and the reverse is not', () => {
  const night = { ...EMPTY_FORM, name: 'In bed', kind: 'time' as const, asked: 'evening' as const };
  assert.deepEqual(formProblems({ ...night, band: 1410, part: 30 }), []);
  assert.deepEqual(newHabitOf({ ...night, band: 1410, part: 30 }, 'h').target, { band: 1410, part: 1470 });
  assert.deepEqual(formProblems({ ...night, band: 30, part: 1410 }), ['The time for partly has to be the same as the time for done, or later.']);
  assert.equal(formProblems({ ...night, asked: 'morning', band: 1410, part: 30 }).length, 1);
});

test("a stored partly comes back into the editor's own field, so a refusal is about a field the screen shows", async () => {
  const { core } = await seedRecord(freshDb(), readState('#age=17&t=13:00'));
  const wake = core.session!.model.habits.get('h-wake')!;
  const form = formOf(wake, dateOfDay(17));
  assert.equal(form.part, wake.target.part);
  assert.equal(formProblems({ ...form, band: form.part! + 15 }).length, 1);
  // emptying partly lets the later band be saved
  const cleared = { ...form, band: form.part! + 15, part: undefined };
  assert.deepEqual(formProblems(cleared), []);
  assert.equal((await editHabit(core, changeOf(cleared, wake))).kind, 'Saved');
  assert.deepEqual(core.session!.model.habits.get('h-wake')!.target, { band: form.part! + 15 });
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
