// The change log (D-25): every change to the record also writes a sealed line, in the same
// transaction. Invented data only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openLine, type ChangeLine } from '../../src/record/changes.ts';
import type { ChangeRow } from '../../src/record/rows.ts';
import { createHabit, editHabit, type NewHabit } from '../../src/record/ops/habits.ts';
import { clearObservation, logObservation } from '../../src/record/ops/observations.ts';
import { saveDayWords } from '../../src/record/ops/days.ts';
import { setSetting } from '../../src/record/ops/settings.ts';
import { SYNCED } from '../../src/record/db.ts';
import type { RecordCore } from '../../src/record/core.ts';
import { filledRecord, openedRecord } from './helpers.ts';

const walk: NewHabit = {
  id: 'h-walk', name: 'CANARY-TEST walk', kind: 'tri', days: [0, 1, 2, 3, 4, 5, 6], asked: 'evening', target: {}, tier: 'focus', startedOn: '2026-01-01',
};

/** Every line in the log, opened, oldest first, each with the slot it was sealed under. */
async function lines(core: RecordCore): Promise<(ChangeLine & { readonly slot: 'r' | 'w'; readonly row: ChangeRow })[]> {
  const rows = await core.db.changes.toArray();
  const out = [];
  for (const row of rows) out.push({ ...(await openLine(core.session!.cipher, row)), slot: row.w ? 'w' as const : 'r' as const, row });
  return out.sort((a, b) => a.changed_at - b.changed_at || a.row.id.localeCompare(b.row.id));
}
const about = async (core: RecordCore, ref: string) => (await lines(core)).filter(l => l.ref === ref);

test('first run logs a create line for every setting it stores', async () => {
  const { core, db } = await openedRecord();
  const settings = await lines(core);
  assert.equal(settings.length, await db.settings.count());
  for (const l of settings) {
    assert.equal(l.kind, 'create');
    assert.match(l.ref ?? '', /^settings\|/);
  }
});

test('a new habit is logged as created, with every field, and first logged when it was made', async () => {
  const { core } = await openedRecord();
  assert.equal((await createHabit(core, walk)).kind, 'Saved');
  const [line, ...more] = await about(core, 'habits|h-walk');
  assert.equal(more.length, 0);
  assert.equal(line?.kind, 'create');
  assert.equal(line?.slot, 'r');
  assert.equal(line?.table, 'habits');
  assert.equal(line?.field_changes?.name?.new, 'CANARY-TEST walk');
  assert.equal(line?.field_changes?.name?.old, undefined);
  assert.equal(line?.first_logged_at, line?.changed_at);
  assert.equal(line?.row.at, line?.changed_at);
  assert.equal(line?.device, core.session?.deviceId);
});

test('an edit logs only what changed, and when the row was first logged', async () => {
  const { core, clock } = await openedRecord();
  await createHabit(core, walk);
  clock.set('2026-01-05T10:00:00Z');
  assert.equal((await editHabit(core, { id: 'h-walk', name: 'CANARY-TEST walk far' })).kind, 'Saved');
  const [made, edited] = await about(core, 'habits|h-walk');
  assert.equal(edited?.kind, 'update');
  assert.deepEqual(Object.keys(edited?.field_changes ?? {}), ['name']);
  assert.deepEqual(edited?.field_changes?.name, { old: 'CANARY-TEST walk', new: 'CANARY-TEST walk far' });
  assert.equal(edited?.first_logged_at, made?.changed_at);
});

test('words are logged under the words key only, and the record key alone never holds them', async () => {
  const { core } = await openedRecord();
  assert.equal((await saveDayWords(core, { date: '2026-01-05', intent: 'CANARY-TEST intent' })).kind, 'Saved');
  const day = await about(core, 'days|2026-01-05');
  const w = day.filter(l => l.slot === 'w');
  assert.equal(w.length, 1);
  assert.equal(w[0]?.field_changes?.intent?.new, 'CANARY-TEST intent');
  for (const l of day.filter(x => x.slot === 'r')) assert.ok(!JSON.stringify(l).includes('CANARY-TEST'));
  for (const l of day) assert.ok(l.slot === 'w' || l.row.w === undefined);
});

test('review #7: the trusted contact, stored under the words key, never reaches a record-key line', async () => {
  const { core } = await openedRecord();
  assert.equal((await setSetting(core, 'contact', 'CANARY-TEST contact')).kind, 'Saved');
  assert.equal((await setSetting(core, 'contact', 'CANARY-TEST other')).kind, 'Saved');
  const contact = await about(core, 'settings|contact');
  assert.equal(contact.length, 2);
  for (const l of contact) assert.equal(l.slot, 'w');
  assert.deepEqual(contact[1]?.field_changes?.value, { old: 'CANARY-TEST contact', new: 'CANARY-TEST other' });
});

test('review #11: clearing logs a delete, and logging the day again logs a recreate', async () => {
  const { core } = await openedRecord();
  await createHabit(core, walk);
  await logObservation(core, { habitId: 'h-walk', date: '2026-01-05', value: 'did' });
  assert.equal((await clearObservation(core, { habitId: 'h-walk', date: '2026-01-05' })).kind, 'Saved');
  assert.equal((await logObservation(core, { habitId: 'h-walk', date: '2026-01-05', value: 'partly' })).kind, 'Saved');
  const kinds = (await about(core, 'observations|h-walk|2026-01-05')).map(l => l.kind);
  assert.deepEqual(kinds, ['create', 'delete', 'recreate']);
});

test('a refused or failed write stores neither the change nor its line', async () => {
  const { core, db, clock } = await openedRecord();
  await createHabit(core, walk);
  const before = await db.changes.count();
  clock.set('2026-01-09T09:00:00Z');
  assert.deepEqual(await logObservation(core, { habitId: 'h-walk', date: '2026-01-05', value: 'did' }), { kind: 'Sealed' });
  assert.equal(await db.changes.count(), before);
  const fail = () => { throw new Error('storage failed'); };
  db.observations.hook('creating', fail);
  await assert.rejects(logObservation(core, { habitId: 'h-walk', date: '2026-01-09', value: 'did' }));
  db.observations.hook('creating').unsubscribe(fail);
  assert.equal(await db.changes.count(), before);
  assert.equal(await db.observations.count(), 0);
});

test('a stored value that will not open stops the write, and nothing is stored', async () => {
  const { core, db } = await openedRecord();
  await createHabit(core, walk);
  const row = await db.habits.get('h-walk');
  await db.habits.put({ ...row!, r: { ...row!.r!, ct: 'AAAA' } });
  const before = await db.changes.count();
  await assert.rejects(editHabit(core, { id: 'h-walk', name: 'CANARY-TEST again' }), { name: 'CipherError' });
  assert.equal(await db.changes.count(), before);
});

test('review #5: a line pointed at another row by its plain ref refuses to open', async () => {
  const { core, db } = await openedRecord();
  await createHabit(core, walk);
  const row = (await db.changes.where('ref').equals('habits|h-walk').first())!;
  await assert.rejects(openLine(core.session!.cipher, { ...row, ref: 'habits|h-other' }), { name: 'CipherError' });
});

test('saving the same values again writes no line', async () => {
  const { core, db } = await openedRecord();
  await createHabit(core, walk);
  await logObservation(core, { habitId: 'h-walk', date: '2026-01-05', value: 'did' });
  const before = await db.changes.count();
  await saveDayWords(core, { date: '2026-01-05' });
  await saveDayWords(core, { date: '2026-01-05' });
  assert.equal(await db.changes.count(), before + 1);     // the day row was made once; the second save changed nothing
});

test('every row a filled record stored has a line, and every line opens', async () => {
  const { core, db } = await filledRecord();
  const refs = new Set((await lines(core)).map(l => l.ref));
  for (const table of SYNCED) {
    for (const row of await db.table(table).toArray() as Record<string, unknown>[]) {
      const key = table === 'observations' ? `${String(row.habit_id)}|${String(row.local_date)}` : String(row.id ?? row.key ?? row.local_date);
      assert.ok(refs.has(`${table}|${key}`), `${table}|${key} has no line`);
    }
  }
});

test('unlock reads nothing from the log', () => {
  assert.ok(!(SYNCED as readonly string[]).includes('changes'));
});
