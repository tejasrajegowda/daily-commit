import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writtenAt } from '../../../src/diary/diaryView.ts';
import { freshDb } from '../../record/helpers.ts';
import { idWrittenAt, seedFixture, type HarnessFixture } from './fixture.ts';
import { readState } from './state.ts';

const EVERY_DAY = [0, 1, 2, 3, 4, 5, 6] as const;

// a small invented record, in the shape the comparison hands in
const FX: HarnessFixture = {
  start: '2026-03-02',
  settings: { wakePlan: 390 },
  habits: [
    { id: 'wake', name: 'CANARY wake', kind: 'time', tier: 'focus', asked: 'morning', days: EVERY_DAY, target: { band: 400, part: 430 }, startDay: 1 },
    { id: 'walk', name: 'CANARY walk', kind: 'tri', tier: 'focus', asked: 'evening', days: [0, 1, 2, 3, 4], target: {}, startDay: 1, tierFrom: { day: 3, tier: 'log' } },
    { id: 'late', name: 'CANARY late', kind: 'tri', tier: 'log', asked: 'evening', days: EVERY_DAY, target: {}, startDay: 4 },
  ],
  history: [
    { opened: true, values: { wake: 395, walk: 'did' }, planned: {}, lightsOut: 1370 },
    { opened: false, values: {}, planned: {} },
    { opened: true, values: { wake: 410 }, planned: { walk: 'meeting' }, lightsOut: 1390 },
  ],
  today: {
    '17': [{ at: 1, id: 'wake', v: 999 }],
    '4': [
      { at: 400, id: 'wake', v: 398 },
      { at: 420, id: 'intent', v: 'CANARY-TEST intent' },
      { at: 1300, id: 'walk', v: 'partly' },
      { at: 1375, id: 'close', v: 1375 },
    ],
  },
  entries: [
    { date: '2026-03-04', at: 1330, body: 'CANARY page one' },
    { date: '2026-03-05', at: 1320, body: 'CANARY page two, written tonight' },
  ],
  notyet: [{ date: '2026-03-03', at: 1260, text: 'CANARY not yet' }],
};

test('an id made for a written time reads back as that time', () => {
  const ms = Date.UTC(2026, 8, 22, 22, 40);
  assert.equal(writtenAt(idWrittenAt(ms, 3)), ms);
});

test('a handed-in record is drawn as of the state: its start, its tiers on that day, its history, and today up to the minute', async () => {
  const { core } = await seedFixture(freshDb(), readState('#age=4&t=12:00', FX.start), FX);
  const m = core.session?.model;
  assert.ok(m);
  assert.equal(m.settings.journeyStart, '2026-03-02');
  assert.equal(m.settings.wakePlan, 390);
  assert.deepEqual([...m.habits.keys()].sort(), ['late', 'wake', 'walk']);
  assert.equal(m.habits.get('walk')?.tierHistory.at(-1)?.tier, 'log');
  assert.equal(m.observations.get('wake|2026-03-02')?.value, 395);
  assert.equal(m.observations.get('walk|2026-03-04')?.planned, 'meeting');
  assert.equal([...m.observations.keys()].some(k => k.endsWith('2026-03-03')), false, 'the day never opened has nothing');
  assert.deepEqual([...m.days.keys()].sort(), ['2026-03-02', '2026-03-04', '2026-03-05']);
  // today at 12:00: the morning's wake-up and intent, not the evening's walk or the close
  assert.equal(m.observations.get('wake|2026-03-05')?.value, 398);
  assert.equal(m.observations.get('wake|2026-03-05')?.loggedAt, Date.UTC(2026, 2, 5, 6, 40), 'logged at its own minute');
  assert.equal(m.observations.has('walk|2026-03-05'), false);
  assert.equal(m.days.get('2026-03-05')?.closedAt, undefined);
  assert.deepEqual([...m.entries.values()].map(e => e.body), ['CANARY page one']);
  assert.equal(m.notyet.size, 1);
});

test('later the same day the evening is logged and the day is closed; before a late starter begins it is absent', async () => {
  const evening = (await seedFixture(freshDb(), readState('#age=4&t=23:00', FX.start), FX)).core.session?.model;
  assert.equal(evening?.observations.get('walk|2026-03-05')?.value, 'partly');
  assert.equal(evening?.days.get('2026-03-05')?.lightsOut, 1375);
  assert.equal(evening?.entries.size, 2);
  const early = (await seedFixture(freshDb(), readState('#age=2&t=09:00', FX.start), FX)).core.session?.model;
  assert.equal(early?.habits.has('late'), false);
  assert.equal(early?.habits.get('walk')?.tierHistory.at(-1)?.tier, 'focus');
  assert.equal(early?.observations.get('wake|2026-03-03')?.value, 999, 'a day without its own script plays day 17');
});
