import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Habit, Observation } from '../../src/rules/types.ts';
import { cueSchedule, type Cue, type CueSettings } from '../../src/rules/cues.ts';
import type { LockedTable } from '../../src/vault/tags.ts';
import type { CueRecord, DayRecord, EntryRecord, HabitRecord, NotYetRecord, ObservationRecord, ReviewRecord, Settings } from '../../src/record/model.ts';
import { openParts, sealParts, type Opened, type Parts, type Plain } from '../../src/record/payload.ts';
import {
  SETTING_KEYS, cueForRules, cueFromParts, cueSettingsOf, cueToParts, dayFromParts, dayToParts, entryFromParts, entryToParts,
  habitFromParts, habitToParts, notYetFromParts, notYetToParts, observationFromParts, observationToParts, reviewFromParts,
  reviewToParts, settingEntries, settingToParts, settingsFromValues, withRestDays,
} from '../../src/record/mapping.ts';
import { stubCipher } from './stubCipher.ts';
import { guarded } from './txGuard.ts';

const cipher = guarded(stubCipher());
const START = '2026-01-05';

// One invented record of every kind.
const walk: HabitRecord = {
  id: 'h1', name: 'CANARY-TEST walk', kind: 'tri', order: 0,
  periods: [{ from: START, until: '2026-02-01' }, { from: '2026-02-08' }],
  schedule: [{ from: START, days: [0, 1, 2, 3, 4], asked: 'evening' }],
  target: {}, tierHistory: [{ tier: 'focus', from: START }],
};
const bed: HabitRecord = {
  id: 'h2', name: 'CANARY-TEST bed', sub: 'CANARY-TEST sub', kind: 'time', order: 1, replaces: 'h0', settledAt: 7,
  periods: [{ from: START }], schedule: [{ from: START, days: [0, 1, 2, 3, 4, 5, 6], asked: 'evening' }],
  target: { band: 1410, part: 1470 }, tierHistory: [{ tier: 'log', from: START }],
};
const late: ObservationRecord = { habitId: 'h2', date: START, kind: 'time', value: 1470, loggedAt: 9, isBackfill: false, editedAfterClose: false };
const planned: ObservationRecord = { habitId: 'h1', date: START, kind: 'tri', planned: 'travelling', loggedAt: 9, isBackfill: true, editedAfterClose: true };
const day: DayRecord = { date: START, closedAt: 1, lightsOut: 1470, restDay: true, reopenedCount: 1, intent: 'CANARY-TEST intent', badNightNote: 'CANARY-TEST note' };
const entry: EntryRecord = { id: 'e1', date: START, body: 'CANARY-TEST body', trashedAt: 3 };
const item: NotYetRecord = { id: 'n1', text: 'CANARY-TEST', why: 'CANARY-TEST why', startedAt: 5 };
const cue: CueRecord = {
  id: 'c1', habitId: 'h1', kind: 'cue', text: 'Stand up and stretch', times: { every: 60, from: 420, to: 1320 },
  fade: { afterDays: 14, to: [420, 780] }, enabled: true, createdOn: START, private: false,
};
const secret: CueRecord = { ...cue, id: 'c2', text: 'CANARY-TEST private', private: true };
const checkin: CueRecord = { id: 'c3', habitId: null, kind: 'checkin', text: 'Morning check-in', times: { at: [420] }, enabled: true, createdOn: START, private: false };
const review: ReviewRecord = { key: 'w:2026-01-05', periodStart: START, periodEnd: '2026-01-11', answers: { went: 'CANARY-TEST' } };
const settings: Settings = { tz: 'UTC', boundary: 240, journeyStart: START, wakePlan: 390, lightsOutPlan: 1350, cuesOn: true };

/** Record → parts → sealed → opened → record. */
async function roundTrip<T>(table: LockedTable, to: (x: T) => Parts, from: (plain: Plain, opened: Opened) => T, record: T): Promise<T> {
  const parts = to(record);
  const opened = await openParts(cipher, table, parts.plain, await sealParts(cipher, table, parts));
  return from(parts.plain, opened);
}

test('every kind of record comes back from storage exactly as it went in', async () => {
  assert.deepEqual(await roundTrip('habits', habitToParts, habitFromParts, walk), walk);
  assert.deepEqual(await roundTrip('habits', habitToParts, habitFromParts, bed), bed);
  assert.deepEqual(await roundTrip('observations', observationToParts, observationFromParts, late), late);
  assert.deepEqual(await roundTrip('observations', observationToParts, observationFromParts, planned), planned);
  assert.deepEqual(await roundTrip('days', dayToParts, dayFromParts, day), day);
  assert.deepEqual(await roundTrip('entries', entryToParts, entryFromParts, entry), entry);
  assert.deepEqual(await roundTrip('notyet', notYetToParts, notYetFromParts, item), item);
  assert.deepEqual(await roundTrip('cues', cueToParts, cueFromParts, cue), cue);
  assert.deepEqual(await roundTrip('cues', cueToParts, cueFromParts, secret), secret);
  assert.deepEqual(await roundTrip('cues', cueToParts, cueFromParts, checkin), checkin);
  assert.deepEqual(await roundTrip('reviews', reviewToParts, reviewFromParts, review), review);
});

test('a private reminder\'s words are locked under the words key, and the rules get none of them', () => {
  assert.equal(cueToParts(secret).r?.text, undefined);
  assert.equal(cueToParts(secret).w?.text, 'CANARY-TEST private');
  assert.equal(cueToParts(cue).w?.text, undefined);            // a shown reminder keeps its words with the rest
  assert.equal(cueForRules(secret).text, '');
  assert.equal(cueForRules(cue).text, 'Stand up and stretch');
});

test('records from storage give the rules their exact shapes, so a cue is never silently empty', async () => {
  const forRules: { habit: Habit; obs: Observation; cue: Cue; cs: CueSettings } = {   // the type check is the first test
    habit: await roundTrip('habits', habitToParts, habitFromParts, walk),
    obs: await roundTrip('observations', observationToParts, observationFromParts, late),
    cue: cueForRules(await roundTrip('cues', cueToParts, cueFromParts, cue)),
    cs: cueSettingsOf(settings),
  };
  assert.deepEqual(forRules.cs, { cuesOn: true, wake: 390, lightsOut: 1350, boundary: 240 });
  assert.equal(cueSchedule(START, [forRules.cue], [forRules.habit], new Map(), forRules.cs).length, 16);
});

test('settings are stored one row each, under their stored names, the contact under the words key', () => {
  assert.deepEqual(settingToParts('wakePlan', 390), { plain: { key: 'wake_plan' }, r: { value: 390 } });
  assert.deepEqual(settingToParts('contact', 'CANARY-TEST'), { plain: { key: 'contact' }, w: { value: 'CANARY-TEST' } });
  assert.deepEqual(settingToParts('badNightNote', 'CANARY-TEST'), { plain: { key: 'bad_night_note' }, w: { value: 'CANARY-TEST' } });
  const withContact: Settings = { ...settings, contact: 'CANARY-TEST' };
  const values = new Map(settingEntries(withContact).map(([name, value]) => [SETTING_KEYS[name], value] as const));
  assert.deepEqual(settingsFromValues(values), withContact);
  assert.equal(settingEntries(settings).length, 6);              // no contact, no row for it
});

test('a rest day gives each habit without a stored observation a planned rest, and leaves a value alone', () => {
  const index = withRestDays([{ habitId: 'h1', date: START, value: 'did' }], [START], ['h1', 'h2']);
  assert.deepEqual(index.get(`h1|${START}`), { habitId: 'h1', date: START, value: 'did' });
  assert.deepEqual(index.get(`h2|${START}`), { habitId: 'h2', date: START, planned: 'rest' });
  assert.equal(index.size, 2);
});
