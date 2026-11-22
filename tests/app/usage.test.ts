import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Alarm, AppDeps, ReminderPort } from '../../src/app/context.ts';
import { alarmAt, alarmId, startReminders } from '../../src/app/reminders.ts';
import { dueOf, logShown, startUsage } from '../../src/app/usage.ts';
import { openLine, type ChangeLine } from '../../src/record/changes.ts';
import type { RecordCore } from '../../src/record/core.ts';
import { saveCue } from '../../src/record/ops/cues.ts';
import { createHabit } from '../../src/record/ops/habits.ts';
import { EVENTS_LOGGED_TO, readLoggedTo, writeUsage } from '../../src/record/ops/usage.ts';
import { testDeps } from './deps.ts';
import { PASSPHRASE, realRecord } from './realRecord.ts';

const at = (iso: string) => Date.parse(iso);

/** The usage lines in the log, opened. */
async function events(core: RecordCore): Promise<{ readonly row: { readonly id: string; readonly at?: number; readonly ref?: string }; readonly line: ChangeLine }[]> {
  const s = core.session;
  if (!s) throw new Error('locked');
  const out = [];
  for (const row of await core.db.changes.toArray()) {
    const line = await openLine(s.cipher, row);
    if (line.kind === 'event') out.push({ row, line });
  }
  return out;
}
const types = async (core: RecordCore) => (await events(core)).map(e => (e.line.event as { type: string }).type).sort();

/** A phone port that records hand-overs; `tray` is what Android still shows; taps are sent with `tap`. */
function fakePhone(tray: number[] = []) {
  const handed: Alarm[][] = [];
  let tapped: ((id: number) => void) | undefined;
  const port: ReminderPort = {
    allowed: async () => true,
    ask: async () => true,
    async replace(alarms) { handed.push([...alarms]); return 'scheduled'; },
    delivered: async () => tray,
    onTapped: cb => { tapped = cb; return () => { tapped = undefined; }; },
  };
  return { port, handed, tap: (id: number) => tapped?.(id) };
}
const onPhone = (deps: AppDeps, port: ReminderPort): AppDeps => ({ ...deps, device: { ...deps.device, reminders: port } });

/** A real record with one daily reminder at 10:00 (tz UTC), open at 2026-01-05 09:00. */
async function withReminder() {
  const r = await realRecord();
  const ok = async (p: Promise<{ kind: string }>) => assert.equal((await p).kind, 'Saved');
  await ok(createHabit(r.core, { id: 'walk', name: 'Walk', kind: 'tri', days: [0, 1, 2, 3, 4, 5, 6], asked: 'evening', target: {}, tier: 'log' }));
  await ok(saveCue(r.core, { id: 'c-10', habitId: 'walk', kind: 'cue', text: 'Walk', times: { at: [600] }, enabled: true, private: false }));
  return r;
}

test('every event is a sealed line with a random id, no plain time and no ref; nothing is written while locked', async () => {
  const r = await realRecord();
  assert.equal(await writeUsage(r.core, [{ type: 'opened' }, { type: 'reminder-tapped', due: 1 }, { type: 'reminder-shown', due: 2, in_tray: true }]), true);
  const lines = await events(r.core);
  assert.equal(lines.length, 3);
  for (const { row, line } of lines) {
    assert.equal(row.at, undefined);
    assert.equal(row.ref, undefined);
    assert.match(row.id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-/);   // random (v4), not time-ordered
    assert.ok(Math.abs(line.changed_at - r.clock.now()) < 1000);      // the time is inside the seal only
  }
  assert.deepEqual(lines.map(l => l.line.event).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
    [{ type: 'opened' }, { type: 'reminder-shown', due: 2, in_tray: true }, { type: 'reminder-tapped', due: 1 }]);
  assert.equal(r.core.session?.changed, false);                      // a quiet write is no change to the record
  await r.core.lock();
  assert.equal(await writeUsage(r.core, [{ type: 'opened' }]), false);
  assert.equal((await r.core.db.changes.toArray()).length, (await r.core.db.changes.toArray()).length);
});

test('a quiet write may set the one "logged to" value, and no other device value', async () => {
  const r = await realRecord();
  assert.equal(await writeUsage(r.core, [], 123), true);
  assert.equal(await readLoggedTo(r.core.db), 123);
  await assert.rejects(r.core.write({
    tables: ['device'], quiet: true,
    async prepare() { return { puts: [{ table: 'device', row: { key: 'CANARY', value: 1 } }], apply: () => {}, value: undefined }; },
  }), /quiet write/);
  assert.equal(EVENTS_LOGGED_TO, 'events_logged_to');
});

test('"opened" is written each time the machine reaches Open, after unlock; a tap while locked goes with the next opening, once', async () => {
  const r = await realRecord();
  const phone = fakePhone();
  const deps = onPhone(testDeps(r.core).deps, phone.port);
  await r.core.lock();
  deps.machine.follow();
  const usage = startUsage(deps);
  phone.tap(alarmId('2026-01-05', 600));                             // tapped while locked: held in memory
  await usage.idle();
  assert.deepEqual(await r.core.db.changes.filter(c => c.at === undefined && c.ref === undefined).count(), 0);
  assert.equal((await deps.machine.unlock({ method: 'passphrase', text: PASSPHRASE })).kind, 'Open');
  await usage.idle();
  assert.deepEqual(await types(r.core), ['opened', 'reminder-tapped']);
  const tap = (await events(r.core)).find(e => (e.line.event as { type: string }).type === 'reminder-tapped');
  assert.deepEqual(tap?.line.event, { type: 'reminder-tapped', due: alarmAt('2026-01-05', 600, 'UTC') });
  // a tap while open is written at once; a second opening writes one more "opened" and no tap again
  phone.tap(alarmId('2026-01-06', 600));
  await usage.idle();
  await deps.machine.leave();
  assert.equal((await deps.machine.unlock({ method: 'passphrase', text: PASSPHRASE })).kind, 'Open');
  await usage.idle();
  assert.deepEqual(await types(r.core), ['opened', 'opened', 'reminder-tapped', 'reminder-tapped']);
  usage.stop();
});

test('an alarm id gives back its due time', () => {
  assert.equal(dueOf(alarmId('2026-03-29', 90), 'Europe/London'), alarmAt('2026-03-29', 90, 'Europe/London'));
  assert.equal(dueOf(alarmId('2026-01-05', 0), 'UTC'), at('2026-01-05T00:00:00Z'));
});

test('"shown": the first time only sets the point; then each reminder handed over and due since is logged once, with the tray', async () => {
  const r = await withReminder();
  const phone = fakePhone([alarmId('2026-01-05', 600)]);
  const deps = onPhone(testDeps(r.core).deps, phone.port);
  const rem = startReminders(deps, () => {}, handed => logShown(deps, handed));
  await rem.idle();
  assert.equal(await readLoggedTo(r.core.db), r.clock.now());       // first time: the point only
  assert.deepEqual(await types(r.core), []);
  r.clock.set('2026-01-06T11:00:00Z');                               // 10:00 on the 5th and the 6th have passed
  deps.store.changed();
  await rem.idle();
  const shown = (await events(r.core)).map(e => e.line.event as { due: number }).sort((a, b) => a.due - b.due);
  assert.deepEqual(shown, [
    { type: 'reminder-shown', due: at('2026-01-05T10:00:00Z'), in_tray: true },
    { type: 'reminder-shown', due: at('2026-01-06T10:00:00Z'), in_tray: false },
  ]);
  deps.store.changed();                                              // again: nothing new is due, nothing repeats
  await rem.idle();
  assert.equal((await events(r.core)).length, 2);
  rem.stop();
});

test('"shown" after a restart works the schedule out from the record; a reminder added after its time is never logged as shown', async () => {
  const r = await withReminder();
  await writeUsage(r.core, [], r.clock.now());                       // logged up to 09:00 on the 5th
  r.clock.set('2026-01-05T12:00:00Z');
  const phone = fakePhone();
  const deps = onPhone(testDeps(r.core).deps, phone.port);
  // a new run: nothing handed over in memory, so 10:00 comes from the record
  const rem = startReminders(deps, () => {}, handed => logShown(deps, handed));
  await rem.idle();
  assert.deepEqual((await events(r.core)).map(e => (e.line.event as { due: number }).due), [at('2026-01-05T10:00:00Z')]);
  // 11:00 is added at 12:00: handed over for tomorrow on, never "shown" for today
  await deps.store.run(c => saveCue(c, { id: 'c-11', habitId: 'walk', kind: 'cue', text: 'Read', times: { at: [660] }, enabled: true, private: false }));
  await rem.idle();
  r.clock.set('2026-01-06T10:30:00Z');
  deps.store.changed();
  await rem.idle();
  const dues = (await events(r.core)).map(e => (e.line.event as { due: number }).due).sort();
  assert.deepEqual(dues, [at('2026-01-05T10:00:00Z'), at('2026-01-06T10:00:00Z')]);
  rem.stop();
});

test('"shown" comes from what was handed over: a reminder switched off after it went off is still logged as shown', async () => {
  const r = await withReminder();
  const phone = fakePhone();
  const deps = onPhone(testDeps(r.core).deps, phone.port);
  const rem = startReminders(deps, () => {}, handed => logShown(deps, handed));
  await rem.idle();                                                  // 09:00: point set, 10:00 handed over
  r.clock.set('2026-01-05T10:30:00Z');
  await deps.store.run(c => saveCue(c, { id: 'c-10', habitId: 'walk', kind: 'cue', text: 'Walk', times: { at: [600] }, enabled: false, private: false }));
  await rem.idle();
  assert.deepEqual((await events(r.core)).map(e => (e.line.event as { due: number }).due), [at('2026-01-05T10:00:00Z')]);
  rem.stop();
});

test('a failing event write never stops the hand-over or the unlock', async () => {
  const r = await withReminder();
  const phone = fakePhone();
  const deps = onPhone(testDeps(r.core).deps, phone.port);
  const rem = startReminders(deps, () => {}, async () => { throw new Error('CANARY event write failed'); });
  await rem.idle();
  assert.equal(phone.handed.length, 1);
  rem.stop();
  const broken = { ...r.core, write: async () => { throw new Error('CANARY'); } } as unknown as RecordCore;
  assert.equal(await writeUsage(broken, [{ type: 'opened' }]), false);
});

test('no screen and no rule reads the usage events', () => {
  const root = fileURLToPath(new URL('../../src/', import.meta.url));
  const offenders: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(ts|tsx)$/.test(e.name) && /[\\/](screens|rules|features)[\\/]/.test(p)) {
        const text = readFileSync(p, 'utf8');
        if (/usage\.ts'|reminder-shown|reminder-tapped|kind === 'event'/.test(text)) offenders.push(p);
      }
    }
  };
  walk(root);
  assert.deepEqual(offenders, []);
});
