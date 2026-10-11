import { test } from 'node:test';
import assert from 'node:assert/strict';
import { alarmAt, alarmId, alarmsFor, DAYS_AHEAD, MAX_ALARMS, startReminders } from '../../src/app/reminders.ts';
import type { Alarm, AppDeps, ReminderPort } from '../../src/app/context.ts';
import { readFlag } from '../../src/record/ops/device.ts';
import { saveCue } from '../../src/record/ops/cues.ts';
import { createHabit } from '../../src/record/ops/habits.ts';
import { setSetting } from '../../src/record/ops/settings.ts';
import { saveEntry } from '../../src/record/ops/words.ts';
import type { RecordCore } from '../../src/record/core.ts';
import { testDeps } from './deps.ts';
import { realRecord } from './realRecord.ts';

const at = (iso: string) => Date.parse(iso);

test('a clock time in the home timezone, not the phone\'s', () => {
  assert.equal(alarmAt('2026-10-08', 7 * 60, 'Asia/Kolkata'), at('2026-10-08T01:30:00Z'));
  assert.equal(alarmAt('2026-10-08', 7 * 60, 'UTC'), at('2026-10-08T07:00:00Z'));
  assert.equal(alarmAt('2026-01-05', 22 * 60 + 30, 'America/Los_Angeles'), at('2026-01-06T06:30:00Z'));
});

test('a DST zone: summer and winter offsets, the hour the clocks skip, and the hour that happens twice', () => {
  assert.equal(alarmAt('2026-07-01', 7 * 60, 'Europe/London'), at('2026-07-01T06:00:00Z'));
  assert.equal(alarmAt('2026-12-01', 7 * 60, 'Europe/London'), at('2026-12-01T07:00:00Z'));
  // 29 March 2026: 01:00 GMT becomes 02:00 BST; 01:30 doesn't exist, so it comes at 02:30 BST
  assert.equal(alarmAt('2026-03-29', 90, 'Europe/London'), at('2026-03-29T01:30:00Z'));
  assert.equal(alarmAt('2026-03-29', 7 * 60, 'Europe/London'), at('2026-03-29T06:00:00Z'));
  // 25 October 2026: 02:00 BST becomes 01:00 GMT; 01:30 happens twice, and the first is used
  assert.equal(alarmAt('2026-10-25', 90, 'Europe/London'), at('2026-10-25T00:30:00Z'));
  assert.equal(alarmAt('2026-10-25', 7 * 60, 'Europe/London'), at('2026-10-25T07:00:00Z'));
  // the US: 8 March 2026, 02:30 is skipped (EST to EDT at 07:00 UTC)
  assert.equal(alarmAt('2026-03-08', 150, 'America/New_York'), at('2026-03-08T07:30:00Z'));
});

test('the same date and minute always get the same id, and ids fit Android\'s 32-bit int', () => {
  assert.equal(alarmId('2026-01-05', 600), 20458 * 1440 + 600);
  assert.equal(alarmId('2026-01-05', 600), alarmId('2026-01-05', 600));
  assert.notEqual(alarmId('2026-01-05', 600), alarmId('2026-01-06', 600));
  assert.notEqual(alarmId('2026-01-05', 600), alarmId('2026-01-05', 601));
  assert.ok(alarmId('2999-12-31', 1439) < 2 ** 31);
});

/** A real record with one habit, at 2026-01-05 09:00 UTC (tz UTC, wake 06:30, lights-out 22:30, the day ends at 04:00). */
async function withHabit() {
  const r = await realRecord();
  const ok = async (p: Promise<{ kind: string }>) => assert.equal((await p).kind, 'Saved');
  await ok(createHabit(r.core, { id: 'walk', name: 'Walk', kind: 'tri', days: [0, 1, 2, 3, 4, 5, 6], asked: 'evening', target: {}, tier: 'log' }));
  const cue = (id: string, minute: number, text: string, priv = false) =>
    ok(saveCue(r.core, { id, habitId: 'walk', kind: 'cue', text, times: { at: [minute] }, enabled: true, private: priv }));
  const model = () => {
    const s = r.core.session;
    if (!s) throw new Error('locked');
    return s.model;
  };
  return { ...r, ok, cue, model };
}

test('seven days ahead, at the minute, in the home timezone; a minute gone by today is not handed over', async () => {
  const t = await withHabit();
  await t.cue('c-10', 600, 'Walk');
  await t.cue('c-08', 480, 'Walk');
  const alarms = alarmsFor(t.model(), '2026-01-05', t.clock.now());
  assert.equal(alarms.filter(a => a.atMs % 86_400_000 === 600 * 60_000).length, DAYS_AHEAD);
  assert.equal(alarms.filter(a => a.atMs % 86_400_000 === 480 * 60_000).length, DAYS_AHEAD - 1);   // 08:00 today has passed
  assert.equal(alarms[0]?.atMs, at('2026-01-05T10:00:00Z'));
  assert.deepEqual(alarms.map(a => a.atMs), [...alarms.map(a => a.atMs)].sort((x, y) => x - y));
  assert.ok(alarms.every(a => a.atMs > t.clock.now()));
});

test('everything due at one minute is one notification, with each text once', async () => {
  const t = await withHabit();
  await t.cue('c-a', 600, 'Walk');
  await t.cue('c-b', 600, 'Stretch');
  const day = alarmsFor(t.model(), '2026-01-05', t.clock.now()).filter(a => a.id === alarmId('2026-01-05', 600));
  assert.deepEqual(day.map(a => a.body), ['Walk · Stretch']);
});

test('a private reminder\'s words are never handed to the phone; alone, it shows only the app\'s name', async () => {
  const t = await withHabit();
  await t.cue('c-p', 600, 'CANARY-L2-PRIVATE-7Q', true);
  await t.cue('c-s', 660, 'Walk');
  await t.cue('c-p2', 660, 'CANARY-L2-PRIVATE-7Q', true);
  const alarms = alarmsFor(t.model(), '2026-01-05', t.clock.now());
  assert.ok(alarms.every(a => !JSON.stringify(a).includes('CANARY')));
  assert.equal(alarms.find(a => a.id === alarmId('2026-01-05', 600))?.body, '');
  assert.equal(alarms.find(a => a.id === alarmId('2026-01-05', 660))?.body, 'Walk');
});

test('pause hands over nothing, check-ins included (C12)', async () => {
  const t = await withHabit();
  await t.cue('c-10', 600, 'Walk');
  await t.ok(saveCue(t.core, { id: 'k-1', habitId: null, kind: 'checkin', text: 'Evening', times: { at: [1200] }, enabled: true, private: false }));
  await t.ok(setSetting(t.core, 'cuesOn', false));
  assert.ok(alarmsFor(t.model(), '2026-01-05', t.clock.now()).length > 0);          // the switch turns cues off; check-ins stay
  await t.ok(setSetting(t.core, 'paused', true));
  assert.deepEqual(alarmsFor(t.model(), '2026-01-05', t.clock.now()), []);
});

test('nothing between lights-out and waking (the rules), and the 04:00 boundary puts 00:30 on the next calendar date', async () => {
  const t = await withHabit();
  await t.cue('c-late', 23 * 60, 'Walk');
  assert.deepEqual(alarmsFor(t.model(), '2026-01-05', t.clock.now()), []);       // after lights-out at 22:30
  await t.ok(setSetting(t.core, 'lightsOutPlan', 90));                           // lights-out 01:30
  await t.cue('c-0030', 30, 'Walk');
  const half = alarmsFor(t.model(), '2026-01-05', t.clock.now()).filter(a => a.body === 'Walk' && a.atMs % 86_400_000 === 30 * 60_000);
  const first = half[0];
  assert.equal(first?.atMs, at('2026-01-06T00:30:00Z'));                          // day 5's 00:30 is the night of the 5th, on the 6th
  assert.equal(first?.id, alarmId('2026-01-06', 30));
  assert.equal(half.length, DAYS_AHEAD);                                         // the app day would drop today's and stop a day early
  assert.equal(half.at(-1)?.atMs, at('2026-01-12T00:30:00Z'));
  assert.equal(half.at(-1)?.id, alarmId('2026-01-12', 30));
});

test('the home timezone decides, also when it keeps summer time', async () => {
  const t = await withHabit();
  await t.cue('c-10', 600, 'Walk');
  const m = t.model();
  const london = alarmsFor({ ...m, settings: { ...m.settings, tz: 'Europe/London' } }, '2026-01-05', t.clock.now());
  assert.equal(london[0]?.atMs, at('2026-01-05T10:00:00Z'));                     // GMT in January
});

test('never more than MAX_ALARMS, the earliest kept', async () => {
  const t = await withHabit();
  await t.ok(saveCue(t.core, { id: 'c-every', habitId: 'walk', kind: 'cue', text: 'Walk', times: { every: 15, from: 420, to: 1320 }, enabled: true, private: false }));
  const alarms = alarmsFor(t.model(), '2026-01-05', t.clock.now());
  assert.ok(alarms.length <= MAX_ALARMS);
  assert.equal(alarms[0]?.atMs, at('2026-01-05T09:15:00Z'));
});

/** A phone that records what it is handed. */
function fakePhone(allow = true) {
  const handed: Alarm[][] = [];
  let release: (() => void) | undefined;
  let holding = false;
  const port: ReminderPort = {
    allowed: async () => allow,
    ask: async () => allow,
    async replace(alarms) {
      if (holding) await new Promise<void>(r => { release = r; });
      handed.push([...alarms]);
      return allow || alarms.length === 0 ? 'scheduled' : 'not-allowed';
    },
  };
  return { port, handed, hold: () => { holding = true; }, release: () => { holding = false; release?.(); } };
}
const onPhone = (deps: AppDeps, port: ReminderPort): AppDeps => ({ ...deps, device: { ...deps.device, reminders: port } });
const runOn = (core: RecordCore) => testDeps(core).deps;

test('an unlock and every saved change hand the schedule over; a change that moves no reminder hands nothing', async () => {
  const t = await withHabit();
  await t.cue('c-10', 600, 'Walk');
  const phone = fakePhone();
  const deps = onPhone(runOn(t.core), phone.port);
  const r = startReminders(deps, () => { throw new Error('not offered when allowed'); });
  await r.idle();
  assert.equal(phone.handed.length, 1);
  await deps.store.run(c => saveEntry(c, { id: 'e-1', body: 'CANARY page' }));
  await r.idle();
  assert.equal(phone.handed.length, 1);                                          // the diary moves no reminder
  await deps.store.run(c => saveCue(c, { id: 'c-11', habitId: 'walk', kind: 'cue', text: 'Walk', times: { at: [660] }, enabled: true, private: false }));
  await r.idle();
  assert.equal(phone.handed.length, 2);
  await deps.store.run(c => setSetting(c, 'paused', true));
  await r.idle();
  assert.deepEqual(phone.handed.at(-1), []);                                     // pause cancels everything
  r.stop();
});

test('locked, nothing is rebuilt, and what was handed over stays', async () => {
  const t = await withHabit();
  await t.cue('c-10', 600, 'Walk');
  const phone = fakePhone();
  const deps = onPhone(runOn(t.core), phone.port);
  const r = startReminders(deps, () => {});
  await r.idle();
  await t.core.lock();
  deps.store.changed();
  await r.idle();
  assert.equal(phone.handed.length, 1);
  r.stop();
});

test('one hand-over at a time, and the last change wins', async () => {
  const t = await withHabit();
  await t.cue('c-10', 600, 'Walk');
  const phone = fakePhone();
  phone.hold();
  const deps = onPhone(runOn(t.core), phone.port);
  const r = startReminders(deps, () => {});
  await deps.store.run(c => saveCue(c, { id: 'c-11', habitId: 'walk', kind: 'cue', text: 'Read', times: { at: [660] }, enabled: true, private: false }));
  await deps.store.run(c => saveCue(c, { id: 'c-12', habitId: 'walk', kind: 'cue', text: 'Rest', times: { at: [720] }, enabled: true, private: false }));
  phone.release();
  await r.idle();
  assert.ok(phone.handed.length <= 2);
  assert.ok(phone.handed.at(-1)?.some(a => a.body === 'Rest'));
  r.stop();
});

test('Android not allowing notifications: nothing is shown, and the setup is offered once ever', async () => {
  const t = await withHabit();
  await t.cue('c-10', 600, 'Walk');
  const phone = fakePhone(false);
  const deps = onPhone(runOn(t.core), phone.port);
  let offered = 0;
  const r = startReminders(deps, () => { offered++; });
  await r.idle();
  await deps.store.run(c => saveCue(c, { id: 'c-11', habitId: 'walk', kind: 'cue', text: 'Walk', times: { at: [660] }, enabled: true, private: false }));
  await r.idle();
  assert.equal(offered, 1);
  assert.equal(await readFlag(t.core.db, 'notif_offered'), true);
  r.stop();
  const again = startReminders(onPhone(runOn(t.core), phone.port), () => { offered++; });   // the app started again
  await again.idle();
  assert.equal(offered, 1);
  again.stop();
});

test('a browser has no reminders: nothing runs', async () => {
  const t = await withHabit();
  const r = startReminders(runOn(t.core), () => { throw new Error('never'); });
  await r.idle();
  r.stop();
});
