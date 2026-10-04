import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cellClass, cells, monthsField, opensLater, sentence, tiers, trend, weekSpans, window } from '../../src/look-back/lookView.ts';
import { rulesInput } from '../../src/record/read.ts';
import { lookup, stateOf } from '../../src/rules/state.ts';
import { freshDb } from '../record/helpers.ts';
import { dateOfDay, readState, START } from '../screens/harness/state.ts';
import { seedRecord } from '../screens/harness/seed.ts';

async function at(day: number) {
  const { core } = await seedRecord(freshDb(), readState(`#age=${day}&t=12:30`));
  const model = core.session!.model;
  return { model, input: rulesInput(model), today: dateOfDay(day) };
}

const text = (w: readonly { readonly text: string }[]) => w.map(p => p.text).join('');

test('the cells follow the rules exactly, and days after today are drawn as still to come', async () => {
  const { input, today } = await at(17);
  const walk = input.habits.find(h => h.id === 'h-walk')!;
  const w = window(START, today);
  for (const c of cells(input, walk, w.from, w.to, today)) {
    if (c.date > today) assert.equal(c.cls, 'fut');
    else assert.equal(c.cls, cellClass(stateOf(walk, lookup(input.index, walk.id, c.date), c.date)));
  }
});

test('the window reaches four weeks back at most, through the end of this week', async () => {
  const w = window(START, dateOfDay(40));
  assert.equal(w.from, dateOfDay(13));
  assert.equal(new Date(`${w.to}T00:00:00Z`).getUTCDay(), 0);       // a Sunday
  assert.deepEqual(window(START, START), { from: START, to: dateOfDay(7), span: 7 });
});

test('week spans add up to the window, and a narrow first week has no label', () => {
  const spans = weekSpans(dateOfDay(6), dateOfDay(21));
  assert.equal(spans.reduce((n, s) => n + s.span, 0), 16);
  assert.equal(spans[0]?.label, '');
});

test('Focus and the habits recorded alongside never include mood', async () => {
  const { input, today } = await at(17);
  const t = tiers(input, today);
  assert.deepEqual(t.focus.map(h => h.name), ['Wake up', 'Walk', 'Practice']);
  assert.ok(!t.log.some(h => h.kind === 'mood'));
});

test('the months field opens on day 35 and has one cell per day; the trend line waits for day 21', async () => {
  const early = await at(20);
  assert.equal(trend(early.input, early.input.habits.find(h => h.id === 'h-wake')!, START, early.today).line.length, 0);
  const later = await at(40);
  const t = trend(later.input, later.input.habits.find(h => h.id === 'h-wake')!, START, later.today);
  assert.ok(t.line.length >= 3);
  assert.ok(t.dots.length > 20);
  const field = monthsField(later.input, START, later.today);
  assert.equal(field.reduce((n, m) => n + m.days.length, 0), 40);
  assert.deepEqual(field.map(m => m.label), ['January', 'February']);
});

test('the sentence counts up in words, starts the record on day 1, and never says more than it can', async () => {
  const first = await at(1);
  assert.match(text(sentence(first.input, first.model, first.today)), /^The record starts today, 5 January\./);
  const later = await at(40);
  const s = text(sentence(later.input, later.model, later.today));
  assert.match(s, /^Wake up by 07:00 on /);
  assert.match(s, /in the last thirty days\./);
  const day17 = await at(17);
  assert.match(text(sentence(day17.input, day17.model, day17.today)), /on one morning\./);
  for (const day of [1, 17, 40]) {
    const r = await at(day);
    assert.doesNotMatch(text(sentence(r.input, r.model, r.today)), /[!%]|is_backfill|edited_after_close|reopened_count/);
  }
});

test('the views still to come are named in advance', () => {
  assert.deepEqual(opensLater(17).map(o => o.what), ['Wake-time trend', 'Am I improving?', 'The shape of months', 'What actually helps']);
  assert.deepEqual(opensLater(60), []);
});
