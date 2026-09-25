import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cueSchedule, cueScheduleAhead, isQuiet, MAX_CHECKINS, timesOn, type Cue, type CueSettings } from '../../src/rules/cues.ts';
import { indexObservations } from '../../src/rules/state.ts';
import { addDays } from '../../src/rules/dates.ts';
import { habit, history, START, tri, walk } from './fixtures.ts';

const settings: CueSettings = { cuesOn: true, wake: 390, lightsOut: 1350 };      // 06:30 – 22:30
const none = indexObservations([]);

function cue(p: Partial<Cue> & Pick<Cue, 'id' | 'times'>): Cue {
  return { habitId: 'walk', kind: 'cue', text: 'Stand up and stretch', enabled: true, createdOn: START, ...p };
}
const morning = cue({ id: 'am', habitId: null, kind: 'checkin', text: 'Morning check-in', times: { at: [420] } });
const evening = cue({ id: 'pm', habitId: null, kind: 'checkin', text: 'Evening check-in', times: { at: [1260] } });

test('an hourly cue fires on the hour inside its window and not beyond', () => {
  const hourly = cue({ id: 'h', times: { every: 60, from: 420, to: 1320 } });
  assert.deepEqual(timesOn(hourly, START), [420, 480, 540, 600, 660, 720, 780, 840, 900, 960, 1020, 1080, 1140, 1200, 1260, 1320]);
});

test('a cue fades to its fixed moments after the set number of days', () => {
  const fading = cue({ id: 'f', times: { every: 60, from: 420, to: 1320 }, fade: { afterDays: 14, to: [420, 780, 1140, 1230] } });
  assert.equal(timesOn(fading, addDays(START, 13)).length, 16);
  assert.deepEqual(timesOn(fading, addDays(START, 14)), [420, 780, 1140, 1230]);
});

test('too-frequent or broken times produce nothing rather than a flood', () => {
  assert.deepEqual(timesOn(cue({ id: 'x', times: { every: 1, from: 420, to: 1320 } }), START), []);
  assert.deepEqual(timesOn(cue({ id: 'x', times: { every: 0, from: 420, to: 1320 } }), START), []);
  assert.deepEqual(timesOn(cue({ id: 'x', times: { at: [-5, 1440, 90.5, 600] } }), START), [600]);
});

test('nothing between lights-out and waking, either side of midnight', () => {
  assert.equal(isQuiet(1350, settings), true);
  assert.equal(isQuiet(100, settings), true);
  assert.equal(isQuiet(389, settings), true);
  assert.equal(isQuiet(390, settings), false);
  const late = { ...settings, lightsOut: 30 };                                      // lights out at 00:30
  assert.equal(isQuiet(1400, late), false);
  assert.equal(isQuiet(30, late), true);
  const s = cueSchedule(START, [cue({ id: 'q', times: { at: [60, 380, 400, 1349, 1350] } })], [walk], none, settings);
  assert.deepEqual(s.map(n => n.at), [400, 1349]);
});

test('everything due at the same minute arrives as one notification', () => {
  const a = cue({ id: 'a', text: 'Stand up and stretch', times: { at: [420] } });
  const b = cue({ id: 'b', text: 'Shoes by the door', times: { at: [420] } });
  const s = cueSchedule(START, [morning, a, b], [walk], none, settings);
  assert.equal(s.length, 1);
  assert.deepEqual(s[0]?.cueIds, ['am', 'a', 'b']);
  assert.deepEqual(s[0]?.texts, ['Morning check-in', 'Stand up and stretch', 'Shoes by the door']);
  assert.equal(s[0]?.checkin, true);
});

test('a planned "not today" or a day off silences that goal\'s cues, never the check-ins', () => {
  const c = cue({ id: 'c', times: { at: [600] } });
  const rest = indexObservations(history('walk', tri('r')));
  assert.deepEqual(cueSchedule(START, [morning, c], [walk], rest, settings).map(n => n.cueIds), [['am']]);
  const weekdays = habit({ id: 'walk', kind: 'tri', days: [0, 1, 2, 3, 4] });
  assert.deepEqual(cueSchedule('2026-01-10', [morning, c], [weekdays], none, settings).map(n => n.cueIds), [['am']]);
  assert.deepEqual(cueSchedule('2026-01-09', [morning, c], [weekdays], none, settings).map(n => n.cueIds), [['am'], ['c']]);
});

test('answering "not today" without a plan does not silence anything — cues ask nothing', () => {
  const c = cue({ id: 'c', times: { at: [600] } });
  const answered = indexObservations(history('walk', tri('n')));
  assert.equal(cueSchedule(START, [c], [walk], answered, settings).length, 1);
});

test('one switch turns every cue off and leaves the check-ins', () => {
  const c = cue({ id: 'c', times: { every: 60, from: 420, to: 1320 } });
  const s = cueSchedule(START, [morning, evening, c], [walk], none, { ...settings, cuesOn: false });
  assert.deepEqual(s.map(n => n.cueIds), [['am'], ['pm']]);
});

test('never more than two check-ins in a day', () => {
  const noon = cue({ id: 'noon', habitId: null, kind: 'checkin', text: 'Midday check-in', times: { at: [720] } });
  const s = cueSchedule(START, [evening, noon, morning], [], none, settings);
  assert.equal(s.filter(n => n.checkin).length, MAX_CHECKINS);
  assert.deepEqual(s.map(n => n.at), [420, 720]);
});

test('disabled cues, cues not created yet, and cues for missing habits are skipped', () => {
  const s = cueSchedule(START, [
    cue({ id: 'off', times: { at: [600] }, enabled: false }),
    cue({ id: 'new', times: { at: [600] }, createdOn: addDays(START, 1) }),
    cue({ id: 'gone', habitId: 'nobody', times: { at: [600] } }),
  ], [walk], none, settings);
  assert.deepEqual(s, []);
});

test('after midnight, a notification fires on the next calendar date but belongs to the same day', () => {
  const late = { ...settings, lightsOut: 60 };
  const s = cueSchedule(START, [cue({ id: 'c', times: { at: [30, 1380] } })], [walk], none, late);
  assert.deepEqual(s.map(n => [n.at, n.day, n.date]), [[1380, START, START], [30, START, addDays(START, 1)]]);
});

test('the week ahead is seven days of the same rules', () => {
  const c = cue({ id: 'c', times: { at: [600, 900] } });
  const s = cueScheduleAhead(START, 7, [morning, c], [walk], none, settings);
  assert.equal(s.length, 21);
  assert.equal(new Set(s.map(n => n.day)).size, 7);
});
