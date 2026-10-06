import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_SHAPES } from '../../src/app/dayShapes.ts';
import { rulesInput } from '../../src/record/read.ts';
import { closeDay } from '../../src/record/ops/days.ts';
import { sheetNow } from '../../src/record/ops/common.ts';
import { logObservation, planDay } from '../../src/record/ops/observations.ts';
import { toDayMinute } from '../../src/rules/clock.ts';
import { asksForTime, fromHm, todayView, shapeRows, skyWords, valueText, wakesAhead, type TodayRow } from '../../src/today/todayView.ts';
import { freshDb } from '../record/helpers.ts';
import { dateOfDay, readState } from '../screens/harness/state.ts';
import { seedRecord } from '../screens/harness/seed.ts';

async function viewAt(hash: string) {
  const state = readState(hash);
  const seeded = await seedRecord(freshDb(), state);
  const model = seeded.core.session!.model;
  return { ...seeded, model, today: dateOfDay(state.day), view: () => todayView(rulesInput(model), model, dateOfDay(state.day), state.minute) };
}

const names = (rows: readonly { readonly habit: { readonly name: string } }[]) => rows.map(r => r.habit.name);

test('a weekday morning: Focus first (Wake up leads), then the morning Log; keys in drawn order', async () => {
  const { view } = await viewAt('#age=17&t=06:05');
  const v = view();
  assert.equal(v.part, 'morning');
  assert.equal(v.dayNumber, 17);
  assert.deepEqual(names(v.morningRows), ['Wake up', 'Walk', 'Practice', 'Plan the day']);
  assert.deepEqual(v.morningRows.map(r => r.key), [1, 2, 3, 4]);
  assert.deepEqual(v.openFocus, []);
});

test('a Saturday has no Practice, and before day 30 there is no Stretch', async () => {
  const { view } = await viewAt('#age=20&t=10:30');
  assert.ok(!names(view().morningRows).includes('Practice'));
  assert.ok(!names(view().morningRows).includes('Stretch'));
  const later = await viewAt('#age=31&t=10:30');
  assert.ok(names(later.view().morningRows).includes('Stretch'));
});

test('the evening lists tonight\'s Log, then Focus still open; answered Focus moves to the chips', async () => {
  const { core, today, view } = await viewAt('#age=17&t=21:30');
  let v = view();
  assert.equal(v.part, 'evening');
  assert.deepEqual(names(v.eveningRows), ['Read', 'Tidy up', 'Water', 'Mood']);
  assert.deepEqual(names(v.openFocus), ['Wake up', 'Walk', 'Practice']);
  assert.equal(v.restOffer, true);
  assert.equal((await logObservation(core, { habitId: 'h-walk', date: today, value: 'did' })).kind, 'Saved');
  v = view();
  assert.deepEqual(names(v.earlier), ['Walk']);
  assert.deepEqual(names(v.openFocus), ['Wake up', 'Practice']);
});

test('evening chips carry the laptop keys after the open Focus, in drawn order', async () => {
  const { core, today, view } = await viewAt('#age=17&t=21:30');
  assert.equal((await logObservation(core, { habitId: 'h-walk', date: today, value: 'partly' })).kind, 'Saved');
  const v = view();
  assert.deepEqual([...v.eveningRows, ...v.openFocus, ...v.earlier].map(r => [r.habit.name, r.key]),
    [['Read', 1], ['Tidy up', 2], ['Water', 3], ['Mood', 4], ['Wake up', 5], ['Practice', 6], ['Walk', 7]]);
});

test('B-2: a habit planned "not today" in the morning and done in the evening is "did", and stays a chip', async () => {
  const { core, today, view } = await viewAt('#age=17&t=21:30');
  assert.equal((await planDay(core, { date: today, plans: [{ habitId: 'h-walk', reason: 'meeting' }] })).kind, 'Saved');
  let walk = view().earlier.find(r => r.habit.id === 'h-walk');
  assert.equal(walk?.planned, 'meeting');
  assert.equal(walk?.state, 'planned');
  assert.equal((await logObservation(core, { habitId: 'h-walk', date: today, value: 'did' })).kind, 'Saved');
  walk = view().earlier.find(r => r.habit.id === 'h-walk');
  assert.equal(walk?.planned, undefined);
  assert.equal(walk?.value, 'did');
  assert.equal(walk?.state, 'did');
});

test('the rest day used, a Focus habit done anyway keeps its value', async () => {
  const { core, today, view } = await viewAt('#age=17&t=21:30');
  assert.equal((await planDay(core, { date: today, restDay: true })).kind, 'Saved');
  assert.deepEqual(names(view().openFocus), []);
  assert.equal(view().earlier.find(r => r.habit.id === 'h-practice')?.planned, 'rest');
  assert.equal((await logObservation(core, { habitId: 'h-practice', date: today, value: 30 })).kind, 'Saved');
  const practice = view().earlier.find(r => r.habit.id === 'h-practice');
  assert.equal(practice?.value, 30);
  assert.equal(practice?.planned, undefined);
});

test('in the evening a morning time row, or a planned one, asks for its time; an evening one tapped at night takes now', async () => {
  const { view } = await viewAt('#age=17&t=21:30');
  const wake = view().openFocus.find(r => r.habit.id === 'h-wake')!;
  assert.equal(asksForTime(wake, 'evening'), true);
  assert.equal(asksForTime(wake, 'morning'), false);
  const night: TodayRow = { ...wake, asked: 'evening' };
  assert.equal(asksForTime(night, 'evening'), false);
  assert.equal(asksForTime({ ...night, planned: 'chose' }, 'evening'), true);
  const walk = view().openFocus.find(r => r.habit.id === 'h-walk')!;
  assert.equal(asksForTime({ ...walk, asked: 'morning' }, 'evening'), false);
});

/** Day 16 at 21:30, then the clock moved on to 03:50: still day 16, and the next morning's wake-up has just happened. */
async function at0350(closed = false) {
  const seeded = await viewAt('#age=16&t=21:30');
  const { core, clock, model, today } = seeded;
  if (closed) assert.equal((await closeDay(core, { date: today, lightsOut: 1378 })).kind, 'Saved');
  const evening = sheetNow(core);
  clock.set(clock.now() + 380 * 60_000);
  const ahead = dateOfDay(17);
  const view = () => todayView(rulesInput(model), model, today, 230);
  return { core, model, today, ahead, evening, view };
}

test('B-5: before the boundary Today offers the day ahead its wake-up; not before midnight', async () => {
  const { view } = await viewAt('#age=16&t=21:30');
  assert.deepEqual(view().ahead, []);
  const late = await at0350();
  const v = late.view();
  assert.equal(v.part, 'evening');
  assert.deepEqual(names(v.ahead), ['Wake up']);
  assert.equal(v.ahead[0]?.value, undefined);
  assert.equal(v.ahead[0]?.key, 1);
  assert.equal(asksForTime(v.ahead[0]!, 'morning'), false);
});

test('B-5: a wake-up at 03:50 is filed to the day ahead as 230, where it is "did"; the day before keeps its own row empty', async () => {
  const { core, model, today, ahead, view } = await at0350();
  const value = toDayMinute(230, 'morning');
  assert.equal(value, 230);
  assert.equal((await logObservation(core, { habitId: 'h-wake', date: ahead, value })).kind, 'Saved');
  const v = view();
  assert.equal(v.ahead[0]?.value, 230);
  assert.equal(v.ahead[0]?.state, 'did');
  assert.equal(model.observations.get(`h-wake|${today}`), undefined);
  assert.equal(v.openFocus.find(r => r.habit.id === 'h-wake')?.value, undefined);
});

test('B-5: the closed day offers it too', async () => {
  const { core, ahead, view } = await at0350(true);
  assert.equal(view().part, 'closed');
  assert.deepEqual(names(view().ahead), ['Wake up']);
  assert.equal((await logObservation(core, { habitId: 'h-wake', date: ahead, value: 230 })).kind, 'Saved');
  assert.equal(view().ahead[0]?.state, 'did');
});

test('B-5: the sheet opened in the evening would refuse it, which is why Today sends the day ahead none', async () => {
  const { core, ahead, evening } = await at0350();
  assert.equal((await logObservation(core, { habitId: 'h-wake', date: ahead, value: 230, sheet: evening })).kind, 'Sealed');
});

test("B-5: a time typed into tonight's empty wake-up goes ahead only when it has just happened, before the boundary", () => {
  assert.equal(wakesAhead(230, 230, 240), true);
  assert.equal(wakesAhead(15, 230, 240), true);
  assert.equal(wakesAhead(235, 230, 240), false);    // later than now: the morning a day ago
  assert.equal(wakesAhead(430, 230, 240), false);    // 07:10: the day's own wake-up
  assert.equal(wakesAhead(230, 1290, 240), false);   // 21:30, before midnight: nothing is ahead yet
});

test('a typed clock time reads as its minute', () => {
  assert.equal(fromHm('07:05'), 425);
  assert.equal(fromHm('00:30'), 30);
  assert.equal(fromHm(''), undefined);
  assert.equal(fromHm('7'), undefined);
});

test('after the day is closed it is closed, whatever the time', async () => {
  const { core, today, view } = await viewAt('#age=17&t=22:58');
  assert.equal((await closeDay(core, { date: today, lightsOut: 1378 })).kind, 'Saved');
  assert.equal(view().part, 'closed');
  assert.ok(view().closedAt);
});

test('no rest day before day 14', async () => {
  const { view } = await viewAt('#age=10&t=21:30');
  assert.equal(view().restOffer, false);
});

test('invariant 4: the morning screen holds nothing from a day before today', async () => {
  const { view, model, today } = await viewAt('#age=40&t=07:00');
  const v = view();
  for (const r of v.morningRows) assert.equal(r.value, model.observations.get(`${r.habit.id}|${today}`)?.value);
  assert.equal(v.intent, model.days.get(today)?.intent);
});

test('values read as they are written beside a row', () => {
  assert.equal(valueText('time', 365), '06:05');
  assert.equal(valueText('time', 1470), '00:30');
  assert.equal(valueText('min', 45), '45m');
  assert.equal(valueText('min', 60), '1h');
  assert.equal(valueText('min', 90), '1h 30m');
  assert.equal(valueText('tri', 'partly'), 'partly');
  assert.equal(valueText('tri', 'not'), 'not today');
  assert.equal(valueText('tri', 'did'), '');
  assert.equal(valueText('mood', 4), '4');
  assert.equal(valueText('count', 3), '3');
  assert.equal(valueText('tri', undefined), '');
});

test('the sky says where you are and what is next, from the day shape', () => {
  const shape = DEFAULT_SHAPES.weekday;
  assert.deepEqual(skyWords(shape, 300, 240), ['Before the day', 'Up at 06:00']);
  assert.deepEqual(skyWords(shape, 400, 240), ['Morning', 'Midday at 12:00']);
  assert.deepEqual(skyWords(shape, 1350, 240), ['Evening', 'Yours until 23:00']);
  assert.deepEqual(skyWords(shape, 1390, 240), ['Lights out', 'Tomorrow starts at 06:00']);
  assert.deepEqual(skyWords(shape, 30, 240), ['Lights out', 'Tomorrow starts at 06:00']);
  for (const t of [0, 300, 700, 1100, 1300, 1439]) assert.doesNotMatch(skyWords(shape, t, 240).join(' '), /[!%]/);
});

test('the shape list ends at lights out once, whether or not the shape has a step there', () => {
  const plain = DEFAULT_SHAPES.weekend;
  const rows = shapeRows(plain);
  assert.deepEqual(rows.map(r => r.label), [...plain.steps.map(s => s.label), 'Lights out']);
  assert.deepEqual(rows.at(-1), { at: plain.lightsOut, end: 1440, label: 'Lights out' });
  assert.equal(rows[0]!.end, plain.steps[1]!.at);

  const own = { ...plain, steps: [...plain.steps, { at: plain.lightsOut, label: 'Bed' }] };
  const ownRows = shapeRows(own);
  assert.deepEqual(ownRows.map(r => r.label), own.steps.map(s => s.label));
  assert.deepEqual(ownRows.at(-1), { at: plain.lightsOut, end: 1440, label: 'Bed' });
  assert.equal(new Set(ownRows.map(r => r.at)).size, ownRows.length);
});
