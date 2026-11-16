import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openRecord, type RecordCore } from '../../src/record/core.ts';
import type { RecordDb } from '../../src/record/db.ts';
import type { ChangeRow } from '../../src/record/rows.ts';
import { LOG_WIPE_CHECK, LOG_WIPE_CHECKED, openLine, wipeLines, type ChangeLine } from '../../src/record/changes.ts';
import { cueToParts, entryToParts } from '../../src/record/mapping.ts';
import { tombstone } from '../../src/record/ops/common.ts';
import { deleteCue, saveCue, type CueSave } from '../../src/record/ops/cues.ts';
import { saveEntry, saveNotYet, sweepTrash, trashEntry, trashNotYet } from '../../src/record/ops/words.ts';
import { exportBackup } from '../../src/record/backup/export.ts';
import { LOG_FORMAT, readFrame } from '../../src/record/backup/format.ts';
import { LOG_DIR, MONTHS_A_LOCK } from '../../src/record/backup/monthLog.ts';
import { restore } from '../../src/record/backup/restore.ts';
import { LATEST } from '../../src/record/backup/snapshot.ts';
import { filledRecord, freshDb } from './helpers.ts';
import { PASS, changer, close, cursorOf, ids, idsIn, monthFiles, must, recoverable, reopen } from './logFiles.ts';
import { memoryFiles } from './memoryFiles.ts';
import { stubBackup } from './stubBackup.ts';
import { guardedBackup } from './txGuard.ts';

// The trash's promise (D-33): 7 days after a diary page or a Not yet item is trashed its words are
// wiped, and the change log's copies of them go too: from the database in the same write, from the
// automatic copy at the next lock, and from each month file holding them, sealed again without them.
// Only a line saying how many were wiped is kept. Invented data only.

const PAGE = 'entries|p-gone';
const JAN = `${LOG_DIR}/2026-01.dclog`;

const linesOf = async (db: RecordDb, ref: string) => (await db.changes.toArray()).filter(l => l.ref === ref);
const wordIds = async (db: RecordDb, ref: string) => (await linesOf(db, ref)).filter(l => l.w !== undefined).map(l => l.id).sort();

async function opened(core: RecordCore, rows: readonly ChangeRow[]): Promise<ChangeLine[]> {
  const s = core.session;
  assert.ok(s, 'the record is open');
  return Promise.all(rows.map(row => openLine(s.cipher, row)));
}

/** A page written, changed and trashed in January (three lines under the words key). Open. */
async function trashedPage() {
  const t = await filledRecord();                           // its clock ends 2026-01-06 20:00
  await must(saveEntry(t.core, { id: 'p-gone', body: 'CANARY-TEST one' }));
  t.clock.advance(3_600_000);
  await must(saveEntry(t.core, { id: 'p-gone', body: 'CANARY-TEST two' }));
  t.clock.set('2026-01-28T10:00:00Z');
  await must(trashEntry(t.core, { id: 'p-gone' }));
  return t;
}

/** The trashed page, January filed into its month file in February while the page was still in the trash. Locked. */
async function filedPage() {
  const t = await trashedPage();
  const m = memoryFiles();
  const change = changer(t.core);
  assert.equal(await close(t.core, m), 'written');
  t.clock.set('2026-02-02T10:00:00Z');
  await change();                                           // 5 days in the trash: not wiped yet
  assert.equal(await close(t.core, m), 'written');
  const words = await wordIds(t.db, PAGE);
  assert.equal(words.length, 3);
  const inJan = await idsIn(m.store.get(JAN), LOG_FORMAT);
  for (const id of words) assert.ok(inJan.includes(id), 'the page\'s words are in January\'s file');
  return { ...t, m, change, words };
}

test('the sweep deletes the page\'s lines under the words key in its own write, keeps its other lines, and adds one `wiped` line holding only a count', async () => {
  const { core, db, clock } = await trashedPage();
  const before = await linesOf(db, PAGE);
  const other = await wordIds(db, 'entries|e-page');
  assert.ok(other.length > 0);
  clock.set('2026-02-05T10:00:00Z');
  assert.deepEqual(await sweepTrash(core), { kind: 'Saved', value: 1 });
  const after = await linesOf(db, PAGE);
  assert.deepEqual(after.filter(l => l.w !== undefined), []);
  for (const l of before.filter(l => l.r !== undefined)) assert.ok(after.some(a => a.id === l.id), 'its other lines stay');
  const lines = await opened(core, after);
  const wiped = lines.filter(l => l.kind === 'wiped');
  assert.deepEqual(wiped.map(l => [l.ref, l.detail, l.field_changes]), [[PAGE, { lines: 3 }, undefined]]);
  // the tombstone's own line says the page went, under the record key, without its words
  const gone = lines.filter(l => l.kind === 'delete');
  assert.equal(gone.length, 1);
  assert.deepEqual(Object.keys(gone[0]?.field_changes ?? {}), ['local_date']);
  assert.deepEqual(await wordIds(db, 'entries|e-page'), other, 'another page is untouched');
});

test('a Not yet item the same: its words lines go, and only the `wiped` line is left about it', async () => {
  const { core, db, clock } = await filledRecord();
  await must(saveNotYet(core, { id: 'n-gone', text: 'CANARY-TEST', why: 'CANARY-TEST why' }));
  await must(trashNotYet(core, { id: 'n-gone' }));
  clock.advance(8 * 86_400_000);
  assert.deepEqual(await sweepTrash(core), { kind: 'Saved', value: 1 });
  const lines = await opened(core, await linesOf(db, 'notyet|n-gone'));
  assert.deepEqual(lines.map(l => [l.kind, l.detail]), [['wiped', { lines: 2 }]]);
});

test('the next lock\'s latest holds none of the wiped lines, and January\'s file is sealed again under a new name without them; the old file goes once that latest is written', async () => {
  const { core, db, clock, m, words } = await filedPage();
  clock.set('2026-02-06T10:00:00Z');
  await reopen(core);                                       // the sweep wipes the page
  assert.deepEqual((await cursorOf(db)).rewrite, ['2026-01.dclog']);
  assert.equal(await close(core, m), 'written');
  assert.deepEqual(monthFiles(m), [`${LOG_DIR}/2026-01.2.dclog`]);
  const jan = await idsIn(m.store.get(`${LOG_DIR}/2026-01.2.dclog`), LOG_FORMAT);
  for (const id of words) assert.ok(!jan.includes(id));
  const range = (await cursorOf(db)).ranges[0];
  assert.deepEqual(jan, await ids(db, l => range !== undefined && (l.at ?? 0) >= range.from && (l.at ?? 0) < range.before));
  for (const id of words) assert.ok(!(await idsIn(m.store.get(LATEST))).includes(id));
  assert.deepEqual(readFrame(m.store.get(LATEST) ?? new Uint8Array()).header.log_files?.map(f => f.name), ['2026-01.2.dclog']);
  assert.deepEqual([...await recoverable(m)].sort(), await ids(db));
  const cursor = await cursorOf(db);
  assert.deepEqual([cursor.rewrite, cursor.retired], [[], []]);
  assert.equal([...m.store.keys()].some(k => k.includes('2026-01.dclog')), false, 'not even kept aside');
});

test('a rewrite that fails to write leaves the old file, the old latest and the mark; the next lock finishes it', async () => {
  const { core, db, clock, m } = await filedPage();
  const latest = m.store.get(LATEST), jan = m.store.get(JAN);
  clock.set('2026-02-06T10:00:00Z');
  await reopen(core);
  m.failOn('rename tmp/month.dclog');
  assert.equal(await close(core, m), 'failed');
  m.failOn(undefined);
  assert.deepEqual([m.store.get(LATEST), m.store.get(JAN)], [latest, jan]);
  assert.deepEqual((await cursorOf(db)).rewrite, ['2026-01.dclog']);
  await reopen(core);
  assert.equal(await close(core, m), 'written');
  assert.deepEqual(monthFiles(m), [`${LOG_DIR}/2026-01.2.dclog`]);
  assert.deepEqual([...await recoverable(m)].sort(), await ids(db));
});

test('a latest that fails after the rewrite: the old file stays, since the last latest names it, so the phone\'s copy still restores whole; the next lock removes it', async () => {
  const { core, db, clock, m } = await filedPage();
  const latest = m.store.get(LATEST), jan = m.store.get(JAN);
  const before = await recoverable(m);
  clock.set('2026-02-06T10:00:00Z');
  await reopen(core);
  m.failOn('rename tmp/snapshot.dcbak');
  assert.equal(await close(core, m), 'failed');
  m.failOn(undefined);
  assert.deepEqual([m.store.get(LATEST), m.store.get(JAN)], [latest, jan]);
  assert.deepEqual(await recoverable(m), before);
  assert.deepEqual((await cursorOf(db)).retired, ['2026-01.dclog']);
  await reopen(core);
  assert.equal(await close(core, m), 'written');
  assert.deepEqual(monthFiles(m), [`${LOG_DIR}/2026-01.2.dclog`]);
  assert.deepEqual((await cursorOf(db)).retired, []);
});

/** A page with words lines in four filed months (January to April), each holding other lines too, wiped in May: more files than one lock seals. */
async function pageAcrossMonths() {
  const t = await filledRecord();
  const m = memoryFiles();
  const change = changer(t.core);
  await must(saveEntry(t.core, { id: 'p-gone', body: 'CANARY-TEST jan' }));
  assert.equal(await close(t.core, m), 'written');
  for (const [month, body] of [['02', 'feb'], ['03', 'mar'], ['04', 'apr']] as const) {
    t.clock.set(`2026-${month}-02T10:00:00Z`);
    await change();
    await must(saveEntry(t.core, { id: 'p-gone', body: `CANARY-TEST ${body}` }));
    assert.equal(await close(t.core, m), 'written');
  }
  t.clock.set('2026-05-02T10:00:00Z');
  await reopen(t.core);
  await must(trashEntry(t.core, { id: 'p-gone' }));
  assert.equal(await close(t.core, m), 'written');
  assert.equal(monthFiles(m).length, 4);
  t.clock.set('2026-05-12T10:00:00Z');
  await reopen(t.core);                                     // the sweep: four files hold the page's words
  assert.deepEqual((await cursorOf(t.db)).rewrite, ['2026-01.dclog', '2026-02.dclog', '2026-03.dclog', '2026-04.dclog']);
  return { ...t, m };
}

test(`more files to seal again than a lock seals (${MONTHS_A_LOCK}): the rest go at the next lock, even with nothing else changed`, async () => {
  assert.ok(MONTHS_A_LOCK < 4);
  const { core, db, m } = await pageAcrossMonths();
  assert.equal(await close(core, m), 'written');
  assert.deepEqual((await cursorOf(db)).rewrite, ['2026-04.dclog']);
  // every line is restorable; April's old file also still has the page's April words, which a restore leaves out
  const back = await recoverable(m);
  for (const id of await ids(db)) assert.ok(back.has(id));
  assert.equal(back.size - (await ids(db)).length, 1);
  await reopen(core);                                       // nothing changes
  assert.equal(await close(core, m), 'written');
  assert.deepEqual(monthFiles(m), ['01', '02', '03', '04'].map(n => `${LOG_DIR}/2026-${n}.2.dclog`));
  assert.deepEqual((await cursorOf(db)).rewrite, []);
  await reopen(core);
  assert.equal(await close(core, m), 'unchanged', 'and then the locks are quiet again');
});

test('restoring a copy whose month file still holds wiped words leaves them out, says how many in its line, and seals that file again at the first lock', async () => {
  const { core, clock, m } = await pageAcrossMonths();
  assert.equal(await close(core, m), 'written');           // April's file still holds the page's April words
  const b = freshDb();
  const bCore = openRecord({ db: b, now: clock.now });
  assert.deepEqual(await restore(bCore, { file: m.store.get(LATEST) ?? new Uint8Array(), secret: PASS, backupCipher: guardedBackup(stubBackup()), log: { files: m.files, months: true } }), { kind: 'Restored' });
  assert.deepEqual(await wordIds(b, PAGE), []);
  assert.deepEqual((await cursorOf(b)).rewrite, ['2026-04.dclog']);
  await reopen(bCore);
  const lines = await opened(bCore, await b.changes.toArray());
  assert.deepEqual(lines.filter(l => l.kind === 'restore').map(l => [l.detail?.months, l.detail?.wiped_left_out]), [[4, 1]]);
  assert.equal(await close(bCore, m), 'written');
  assert.deepEqual(monthFiles(m), ['01', '02', '03', '04'].map(n => `${LOG_DIR}/2026-${n}.2.dclog`));
  assert.deepEqual([...await recoverable(m)].sort(), await ids(b));
});

test('a month that held nothing but the wiped words is dropped, never sealed empty: its range leaves the cursor and its file goes', async () => {
  const t = await filledRecord();
  const m = memoryFiles();
  await must(saveEntry(t.core, { id: 'p-gone', body: 'CANARY-TEST jan' }));
  assert.equal(await close(t.core, m), 'written');
  t.clock.set('2026-02-02T10:00:00Z');
  await reopen(t.core);
  await must(saveEntry(t.core, { id: 'p-gone', body: 'CANARY-TEST feb' }));   // February's only line
  assert.equal(await close(t.core, m), 'written');
  t.clock.set('2026-03-02T10:00:00Z');
  await reopen(t.core);
  await must(trashEntry(t.core, { id: 'p-gone' }));
  assert.equal(await close(t.core, m), 'written');
  assert.deepEqual(monthFiles(m), [JAN, `${LOG_DIR}/2026-02.dclog`]);
  t.clock.set('2026-03-10T10:00:00Z');
  await reopen(t.core);
  assert.equal(await close(t.core, m), 'written');
  assert.deepEqual(monthFiles(m), [`${LOG_DIR}/2026-01.2.dclog`]);
  assert.deepEqual((await cursorOf(t.db)).ranges.map(r => r.name), ['2026-01.2.dclog']);
  assert.deepEqual([...await recoverable(m)].sort(), await ids(t.db));
  const b = freshDb();
  const bCore = openRecord({ db: b, now: t.clock.now });
  assert.deepEqual(await restore(bCore, { file: m.store.get(LATEST) ?? new Uint8Array(), secret: PASS, backupCipher: guardedBackup(stubBackup()), log: { files: m.files, months: true } }), { kind: 'Restored' });
  assert.deepEqual(await ids(b), await ids(t.db));
});

test('restoring a copy made while the page was still in the trash brings it back in the trash, and the sweep wipes it again', async () => {
  const { core, db, clock, m } = await filedPage();
  const copy = m.store.get(LATEST) ?? new Uint8Array();
  clock.set('2026-02-06T10:00:00Z');
  await reopen(core);                                       // wiped here; January marked
  await core.lock();
  const b = freshDb();
  const bCore = openRecord({ db: b, now: clock.now });
  assert.deepEqual(await restore(bCore, { file: copy, secret: PASS, backupCipher: guardedBackup(stubBackup()), log: { files: m.files, months: true } }), { kind: 'Restored' });
  assert.deepEqual((await cursorOf(b)).rewrite, [], 'the restored record\'s cursor decides');
  assert.equal((await wordIds(b, PAGE)).length, 3);
  await reopen(bCore);                                      // over its 7 days: wiped again
  assert.deepEqual(await wordIds(b, PAGE), []);
  assert.deepEqual((await cursorOf(b)).rewrite, ['2026-01.dclog']);
  assert.deepEqual(await wordIds(db, PAGE), [], 'and the record it came from stays wiped');
});

test('an id saved again after its wipe: a copy whose month file still has the old words brings them back, and the first unlock wipes exactly those, keeping the new words', async () => {
  const { core, db, clock, m } = await pageAcrossMonths();
  await must(saveEntry(core, { id: 'p-gone', body: 'CANARY-TEST again' }));   // the same id, saved again after its wipe
  const fresh = await wordIds(db, PAGE);
  assert.equal(fresh.length, 1);
  assert.equal(await close(core, m), 'written');           // April's file is still the old one, words and all
  const b = freshDb();
  const bCore = openRecord({ db: b, now: clock.now });
  assert.deepEqual(await restore(bCore, { file: m.store.get(LATEST) ?? new Uint8Array(), secret: PASS, backupCipher: guardedBackup(stubBackup()), log: { files: m.files, months: true } }), { kind: 'Restored' });
  assert.equal((await wordIds(b, PAGE)).length, 2, 'the row is live, so the restore alone can\'t tell');
  await reopen(bCore);
  assert.deepEqual(await wordIds(b, PAGE), fresh);
  assert.ok((await cursorOf(b)).rewrite.includes('2026-04.dclog'));
  assert.equal(await close(bCore, m), 'written');
  const back = await recoverable(m);
  assert.deepEqual([...back].sort(), await ids(b));
});

test('a page an earlier build wiped (tombstone kept, its words lines not) is cleaned once, at the first unlock', async () => {
  const { core, db, clock } = await trashedPage();
  const words = await wordIds(db, PAGE);
  await core.lock();
  // the row as that build's sweep left it; its lines untouched
  await db.entries.put(tombstone(entryToParts({ id: 'p-gone', date: '2026-01-06', body: '' }), { updated_at: clock.now(), updated_by: 'CANARY-device' }) as never);
  await db.device.put({ key: LOG_WIPE_CHECK, value: '' });
  await reopen(core);
  assert.deepEqual(await wordIds(db, PAGE), []);
  const lines = await opened(core, await linesOf(db, PAGE));
  assert.deepEqual(lines.filter(l => l.kind === 'wiped').map(l => l.detail), [{ lines: words.length }]);
  assert.equal((await db.device.get(LOG_WIPE_CHECK))?.value, LOG_WIPE_CHECKED);
  await core.lock();
  await reopen(core);
  assert.equal((await opened(core, await linesOf(db, PAGE))).filter(l => l.kind === 'wiped').length, 1, 'once');
});

test('a replaced file that can\'t be removed is tried again after later backups, but never makes an idle lock write one', async () => {
  const { core, db, clock, m, change } = await filedPage();
  clock.set('2026-02-06T10:00:00Z');
  await reopen(core);
  m.failOn('remove backup/log');
  assert.equal(await close(core, m), 'written');
  assert.deepEqual([(await cursorOf(db)).retired, (await cursorOf(db)).unremoved], [[], ['2026-01.dclog']]);
  await reopen(core);
  assert.equal(await close(core, m), 'unchanged', 'no backup for it alone');
  m.failOn(undefined);
  await change();
  assert.equal(await close(core, m), 'written');
  assert.deepEqual(monthFiles(m), [`${LOG_DIR}/2026-01.2.dclog`]);
  assert.deepEqual((await cursorOf(db)).unremoved, []);
});

test('"replace everything" while a month file still holds wiped words removes it rather than keeping it aside', async () => {
  const { core, clock, m, words } = await filedPage();
  clock.set('2026-02-06T10:00:00Z');
  await reopen(core);                                       // wiped; January marked
  m.failOn('rename tmp/month.dclog');
  assert.equal(await close(core, m), 'failed');             // January still holds the words
  m.failOn(undefined);
  await reopen(core);
  const made = await exportBackup(core, { appVersion: '0.1.0' });
  if (made.kind !== 'Saved') throw new Error(made.kind);
  assert.deepEqual(await restore(core, { file: made.value.bytes, secret: PASS, backupCipher: guardedBackup(stubBackup()), replace: { files: m.files, appVersion: '0.1.0' }, log: { files: m.files, months: false } }), { kind: 'Restored' });
  for (const [path, bytes] of m.store) {
    if (!path.endsWith('.dclog')) continue;
    const held = await idsIn(bytes, LOG_FORMAT);
    for (const id of words) assert.ok(!held.includes(id), `${path} keeps a wiped line`);
  }
});

test('"replace everything" with a file still holding wiped words: the record gets none of them, and the file is not kept as latest', async () => {
  const { core, db, clock } = await trashedPage();
  const m = memoryFiles();
  assert.equal(await close(core, m), 'written');
  // a record as a build from before the log followed the trash left it: the tombstone, its words lines kept
  await db.entries.put(tombstone(entryToParts({ id: 'p-gone', date: '2026-01-06', body: '' }), { updated_at: clock.now(), updated_by: 'CANARY-device' }) as never);
  await db.device.put({ key: LOG_WIPE_CHECK, value: LOG_WIPE_CHECKED });
  await reopen(core);
  const made = await exportBackup(core, { appVersion: '0.1.0' });
  if (made.kind !== 'Saved') throw new Error(made.kind);
  assert.deepEqual(await restore(core, { file: made.value.bytes, secret: PASS, backupCipher: guardedBackup(stubBackup()), replace: { files: m.files, appVersion: '0.1.0' }, log: { files: m.files, months: false } }), { kind: 'Restored' });
  assert.deepEqual(await wordIds(db, PAGE), []);
  assert.equal(m.store.has(LATEST), false);
  await reopen(core);
  assert.deepEqual((await opened(core, await db.changes.toArray())).filter(l => l.kind === 'restore').map(l => l.detail?.wiped_left_out), [3]);
  assert.equal(await close(core, m), 'written');
  assert.deepEqual(await idsIn(m.store.get(LATEST)), await ids(db));
});

test('a wipe whose lines changed after they were read aborts the whole write', async () => {
  const { db } = await trashedPage();
  const before = await db.changes.count();
  await assert.rejects(db.transaction('rw', [db.changes, db.device], () => wipeLines(db, [{ ref: PAGE, ids: ['CANARY-not-there'], ats: [], all: true }])), /the log changed/);
  assert.equal(await db.changes.count(), before);
});

// A reminder has no trash: deleting one is for good, so a private one's words leave the log at once (D-35).

const REMINDER = 'cues|c-gone';
const reminder = (text: string, isPrivate: boolean): CueSave =>
  ({ id: 'c-gone', habitId: null, kind: 'checkin', text, times: { at: [600] }, enabled: true, private: isPrivate });

/** A private reminder, its words lines kept, as a build from before D-35 left it once deleted. Open. */
async function deletedBeforeTheRule(checked: string) {
  const t = await filledRecord();
  await must(saveCue(t.core, reminder('CANARY-TEST', true)));
  const cue = t.core.session?.model.cues.get('c-gone');
  assert.ok(cue);
  await t.core.lock();
  await t.db.cues.put(tombstone(cueToParts(cue), { updated_at: t.clock.now(), updated_by: 'CANARY-device' }) as never);
  await t.db.device.put({ key: LOG_WIPE_CHECK, value: checked });
  await reopen(t.core);
  return t;
}

test('a private reminder deleted: its words lines go in the delete\'s own write, its other lines stay, and one `wiped` line says how many', async () => {
  const { core, db, clock } = await filledRecord();
  await must(saveCue(core, reminder('CANARY-TEST one', true)));
  clock.advance(60_000);
  await must(saveCue(core, reminder('CANARY-TEST two', true)));
  const before = await linesOf(db, REMINDER);
  assert.equal(before.filter(l => l.w !== undefined).length, 2);
  clock.advance(60_000);
  await must(deleteCue(core, { id: 'c-gone' }));
  const after = await linesOf(db, REMINDER);
  assert.deepEqual(after.filter(l => l.w !== undefined), []);
  for (const l of before.filter(l => l.r !== undefined)) assert.ok(after.some(a => a.id === l.id), 'its other lines stay');
  const lines = await opened(core, after);
  assert.deepEqual(lines.filter(l => l.kind === 'wiped').map(l => l.detail), [{ lines: 2 }]);
  assert.ok(lines.every(l => !JSON.stringify(l).includes('CANARY-TEST')), 'no line left about it holds its words');
});

test('a reminder that was never private had no words to wipe: deleting it adds no `wiped` line', async () => {
  const { core, db } = await filledRecord();
  await must(saveCue(core, reminder('Stand up', false)));
  await must(deleteCue(core, { id: 'c-gone' }));
  const lines = await opened(core, await linesOf(db, REMINDER));
  assert.deepEqual(lines.map(l => l.kind).sort(), ['create', 'delete']);
});

test('a reminder deleted before its words followed it is cleaned at the next unlock, though the check had already run for the trash', async () => {
  const { core, db } = await deletedBeforeTheRule('done');
  assert.deepEqual(await wordIds(db, REMINDER), []);
  const lines = await opened(core, await linesOf(db, REMINDER));
  assert.deepEqual(lines.filter(l => l.kind === 'wiped').map(l => l.detail), [{ lines: 1 }]);
  assert.equal((await db.device.get(LOG_WIPE_CHECK))?.value, LOG_WIPE_CHECKED);
});

test('restoring a copy that still holds a deleted reminder\'s words leaves them out', async () => {
  const { core, db, clock } = await deletedBeforeTheRule(LOG_WIPE_CHECKED);
  assert.equal((await wordIds(db, REMINDER)).length, 1, 'the copy is made with them still there');
  const made = await exportBackup(core, { appVersion: '0.1.0' });
  if (made.kind !== 'Saved') throw new Error(made.kind);
  const b = freshDb();
  const bCore = openRecord({ db: b, now: clock.now });
  assert.deepEqual(await restore(bCore, { file: made.value.bytes, secret: PASS, backupCipher: guardedBackup(stubBackup()) }), { kind: 'Restored' });
  assert.deepEqual(await wordIds(b, REMINDER), []);
});

test('a manual export after the wipe holds none of the wiped lines', async () => {
  const { core, db, clock, words } = await filedPage();
  clock.set('2026-02-06T10:00:00Z');
  await reopen(core);
  const made = await exportBackup(core, { appVersion: '0.1.0' });
  if (made.kind !== 'Saved') throw new Error(made.kind);
  const held = await idsIn(made.value.bytes);
  for (const id of words) assert.ok(!held.includes(id));
  assert.deepEqual(held, await ids(db));
});
