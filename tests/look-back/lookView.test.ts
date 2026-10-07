import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cellClass, cells, monthsField, opensLater, sentence, tiers, trend, valueWords, weekSpans, window } from '../../src/look-back/lookView.ts';
import { rulesInput } from '../../src/record/read.ts';
import { addDays } from '../../src/rules/dates.ts';
import { toDayMinute } from '../../src/rules/clock.ts';
import { indexObservations, lookup, stateOf } from '../../src/rules/state.ts';
import { freshDb } from '../record/helpers.ts';
import { habit, history, scheduled, tri, walk } from '../rules/fixtures.ts';
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
  const d25 = await at(25);
  assert.match(text(sentence(d25.input, d25.model, d25.today)),/mornings, all of them since \d{1,2} Jan\./, 'in the first month, since the first one');
  for (const day of [1, 17, 40]) {
    const r = await at(day);
    assert.doesNotMatch(text(sentence(r.input, r.model, r.today)), /[!%]|is_backfill|edited_after_close|reopened_count/);
  }
});

test('the views still to come are named in advance, with no causal claim', () => {
  assert.deepEqual(opensLater(17, true).map(o => o.what), ['Wake-time trend', 'Am I improving?', 'The shape of months', 'What seems to go well together']);
  assert.deepEqual(opensLater(60, true), []);
});

test('R3-10: the wake-time trend is named only when a time habit exists', () => {
  assert.deepEqual(opensLater(17, false).map(o => o.what), ['Am I improving?', 'The shape of months', 'What seems to go well together']);
});

test('R3-12: a night-asked time habit plots DayMinutes, not clock times, so an after-midnight time stays near an evening one', () => {
  const night = { ...habit({ id: 'night', kind: 'time', schedule: scheduled([0, 1, 2, 3, 4, 5, 6], START, 'evening') }), name: 'In bed', order: 0 };
  const cells = [
    { value: toDayMinute(23 * 60 + 40, 'evening') },  // 23:40
    { value: toDayMinute(15, 'evening') },             // 00:15, the next night
    { value: toDayMinute(23 * 60 + 50, 'evening') },   // 23:50
  ];
  const idx = indexObservations(history('night', cells));
  const input = { index: idx, habits: [], cues: [], cueSettings: {} as never };
  const t = trend(input, night, START, addDays(START, 2));
  assert.deepEqual(t.dots.map(d => d.minute), [1420, 1455, 1430]);     // DayMinutes, not wrapped back to 15
  assert.ok(Math.max(...t.dots.map(d => d.minute)) - Math.min(...t.dots.map(d => d.minute)) < 60, 'all three sit within an hour of each other on the night axis');
});

test('R3-8: a logged "not today" and a day never answered read the same, a faint dash', () => {
  const w = { ...walk, name: 'Walk', order: 0 };
  const idx = indexObservations(history('walk', tri('dn.')));
  const input = { index: idx, habits: [], cues: [], cueSettings: {} as never };
  assert.equal(valueWords(w, input, addDays(START, 1)), '—');  // a logged miss
  assert.equal(valueWords(w, input, addDays(START, 2)), '—');  // never answered
  assert.equal(valueWords(w, input, START), 'did it');         // unaffected: an actual answer still reads
});
