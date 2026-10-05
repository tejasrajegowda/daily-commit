// Canary level 1: an invented sentence goes into every locked field, through every way the record
// saves, and is then searched for everywhere the app keeps anything. It must be found nowhere. The
// same search is first shown to find it where it is plainly there, so a quiet search proves
// something.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { openDb, type RecordDb } from '../../src/record/db.ts';
import { openRecord, type RecordCore } from '../../src/record/core.ts';
import { parseJsonBytes } from '../../src/record/bytes.ts';
import { runMigrations } from '../../src/record/migrations.ts';
import { LOCKED } from '../../src/record/payload.ts';
import { firstRun } from '../../src/record/ops/firstRun.ts';
import { createHabit, editHabit, retireHabit, returnHabit, settleHabit, swapFocus } from '../../src/record/ops/habits.ts';
import { clearObservation, logObservation, planDay } from '../../src/record/ops/observations.ts';
import { closeDay, reopenDay, saveDayWords } from '../../src/record/ops/days.ts';
import { restoreEntry, restoreNotYet, saveEntry, saveNotYet, trashEntry, trashNotYet } from '../../src/record/ops/words.ts';
import { deleteCue, saveCue } from '../../src/record/ops/cues.ts';
import { saveReview } from '../../src/record/ops/reviews.ts';
import { setSetting } from '../../src/record/ops/settings.ts';
import { closeSession, openSession } from '../../src/record/ops/session.ts';
import { replaceWrapper, vaultRows } from '../../src/record/ops/vault.ts';
import { gunzip, gzip } from '../../src/record/backup/body.ts';
import { exportBackup } from '../../src/record/backup/export.ts';
import { readFrame } from '../../src/record/backup/format.ts';
import { restore } from '../../src/record/backup/restore.ts';
import { openStorage } from '../../src/record/upgrade.ts';
import { backupCipher } from '../../src/vault/backupCipher.ts';
import type { RowCipher, Secret } from '../../src/vault/cipher.ts';
import { createVault } from '../../src/vault/keys.ts';
import { systemRandom } from '../../src/vault/random.ts';
import { TABLE_TAGS } from '../../src/vault/tags.ts';
import { changePassphrase, sessionCiphers, unlockWithSecret } from '../../src/vault/vault.ts';
import { filledRecord } from '../record/helpers.ts';
import { SETTINGS, testClock } from '../record/fixtures.ts';
import { memoryFiles } from '../record/memoryFiles.ts';
import { STUB_SECRETS, stubBackup } from '../record/stubBackup.ts';
import { TEST_SCHEMAS, TEST_V2 } from '../record/v2.ts';

const CANARY = 'CANARY-Q7XW-NOT-REAL';
const PASS: Secret = { method: 'passphrase', text: `${CANARY} passphrase` };
const NEXT: Secret = { method: 'passphrase', text: `${CANARY} next passphrase` };
const never = () => new Promise<void>(() => {});

async function rowsNow(core: RecordCore) {
  const rows = await vaultRows(core);
  if (!rows) throw new Error('no vault');
  return rows;
}

/** The free-text fields: each one must have carried the canary at least once. */
const TEXT_FIELDS = [
  'set.w.value', 'hab.r.name', 'hab.r.sub', 'day.w.intent', 'day.w.remark', 'day.w.bad_night_note', 'ent.w.body',
  'nyt.w.text', 'nyt.w.why', 'cue.r.text', 'cue.w.text', 'rev.w.answers',
];

/**
 * Locked fields that no operation in record/ writes yet, each with the reason. The run fails if one
 * of them is reached, and the list is pinned below, so it can only shrink.
 */
const NOT_WRITTEN_YET: Readonly<Record<string, string>> = {};

/** Every form the canary could leak in: UTF-8, UTF-16 either way round, and base64 or base64url at each alignment. */
function formsOf(text: string): Buffer[] {
  const bytes = Buffer.from(text, 'utf8');
  const forms = [bytes, Buffer.from(text, 'utf16le'), Buffer.from(text, 'utf16le').swap16()];
  for (const shift of [0, 1, 2]) {
    const b64 = Buffer.concat([Buffer.alloc(shift), bytes]).toString('base64');
    const inner = b64.slice(4, -4);                      // only the characters every alignment shares
    if (inner.length < 8) continue;                      // too short to mean anything
    forms.push(Buffer.from(inner), Buffer.from(inner.replaceAll('+', '-').replaceAll('/', '_')));
  }
  return forms;
}

/** Which forms of which secrets a set of bytes holds. */
function leaks(bytes: Uint8Array, secrets: readonly string[]): string[] {
  const hay = Buffer.from(bytes);
  return secrets.flatMap(secret => formsOf(secret).filter(form => hay.includes(form)).map(form => `${secret.slice(0, 12)}…: ${form.toString('latin1').slice(0, 16)}`));
}

/** Records which locked fields each seal carried, and which held the canary. */
function recording(cipher: RowCipher) {
  const reached = new Set<string>();
  const carried = new Set<string>();
  const wrapped: RowCipher = {
    async seal(ctx, plain) {
      const fields = parseJsonBytes(plain) as Record<string, unknown>;
      for (const [name, value] of Object.entries(fields)) {
        if (name === 'pv') continue;
        reached.add(`${ctx.table}.${ctx.slot}.${name}`);
        if (JSON.stringify(value).includes(CANARY)) carried.add(`${ctx.table}.${ctx.slot}.${name}`);
      }
      return cipher.seal(ctx, plain);
    },
    open: (ctx, env) => cipher.open(ctx, env),
  };
  return { cipher: wrapped, reached, carried };
}

type Place = { readonly where: string; readonly bytes: Uint8Array };

/** Every string inside some JSON, at any depth, with its base64url undone: each locked value's bytes. */
function innerValues(where: string, json: unknown, out: Place[] = []): Place[] {
  if (typeof json === 'string') {
    if (/^[A-Za-z0-9_-]+$/.test(json)) out.push({ where, bytes: Buffer.from(json, 'base64url') });
  } else if (typeof json === 'object' && json !== null) {
    for (const [name, part] of Object.entries(json)) innerValues(`${where} ${name}`, part, out);
  }
  return out;
}

/** Every stored row of every table, as JSON, and every locked value's bytes after its base64url is undone. */
async function storedBytes(db: RecordDb): Promise<Place[]> {
  const out: Place[] = [];
  for (const table of db.tables) {
    const rows = (await table.toArray()) as Record<string, unknown>[];
    out.push({ where: `rows of ${table.name}`, bytes: Buffer.from(JSON.stringify(rows)) });
    innerValues(table.name, rows, out);
  }
  return out;
}

/**
 * A file as kept, plus what is inside it: a backup's body once opened and gunzipped, or a gzip copy
 * unzipped, and then every value inside that with its base64url undone. A file can hold a row the
 * record no longer has (a page swept from the trash), so the file is searched as deeply as the rows.
 */
async function fileBytes(path: string, bytes: Uint8Array, secret: Secret): Promise<Place[]> {
  const out: Place[] = [{ where: path, bytes }];
  let inner: Uint8Array | undefined;
  if (path.endsWith('.dcbak')) {
    const f = readFrame(bytes);
    const opened = await backupCipher().openBody(f.headerBytes, f.iv, f.ct, f.header.wrappers, secret);
    inner = await gunzip(opened.body);
  } else if (path.endsWith('.gz')) {
    inner = await gunzip(bytes);
  }
  if (inner) {
    out.push({ where: `${path}, unzipped`, bytes: inner });
    let json: unknown;
    try {
      json = JSON.parse(Buffer.from(inner).toString('utf8'));
    } catch {
      json = undefined;
    }
    innerValues(`${path}, unzipped,`, json, out);
  }
  return out;
}

test('the search finds the canary where it is plainly there: a stand-in record, and a body only once it is unzipped', async () => {
  const { db, core } = await filledRecord();                            // the stand-in cipher keeps nothing secret
  const rows = await storedBytes(db);
  assert.ok(rows.some(r => leaks(r.bytes, ['CANARY-TEST']).length > 0));                 // in each value, once its base64url is undone
  const result = await exportBackup(core, { appVersion: '0.1.0' });
  if (result.kind !== 'Saved') throw new Error(result.kind);
  const f = readFrame(result.value.bytes);
  assert.deepEqual(leaks(result.value.bytes, ['h-walk']), []);          // a plain habit id: the gzip alone hides it
  const opened = await stubBackup().openBody(f.headerBytes, f.iv, f.ct, f.header.wrappers, { method: 'passphrase', text: STUB_SECRETS.passphrase });
  assert.ok(leaks(await gunzip(opened.body), ['h-walk']).length > 0);
});

test('canary level 1: through every write path into every locked field, then found nowhere: rows, values, export, snapshots, safety and upgrade copies', async () => {
  const deps = { name: 'daily-commit-canary', indexedDB: new IDBFactory(), IDBKeyRange };
  const db = openDb(deps);
  const clock = testClock('2026-01-07T09:00:00Z');
  const core: RecordCore = openRecord({ db, now: clock.now });
  const made = await createVault(PASS.text, systemRandom, clock.now());
  const rec = recording(sessionCiphers(made.keys).cipher);
  const backup = sessionCiphers(made.keys).backup;
  const must = async (what: string, pending: Promise<{ readonly kind: string }>) => {
    const result = await pending;
    assert.equal(result.kind, 'Saved', `${what}: ${JSON.stringify(result)}`);
  };
  const m = memoryFiles();
  const close = () => closeSession(core, { files: m.files, sleep: never, appVersion: '0.1.0' });

  await must('first run', firstRun(core, { cipher: rec.cipher, backup, vault: made.vault, wrappers: made.wrappers, settings: { ...SETTINGS, contact: `${CANARY} contact` } }));
  await must('habit', createHabit(core, {
    id: 'h-a', name: `${CANARY} name`, sub: `${CANARY} sub`, kind: 'tri', days: [0, 1, 2, 3, 4, 5, 6], asked: 'evening', target: {}, tier: 'focus', startedOn: '2026-01-05',
    cues: [{ id: 'c-a', text: `${CANARY} cue`, times: { every: 60, from: 420, to: 1320 }, fade: { afterDays: 14, to: [480] }, private: false }],
  }));
  await must('habit that replaces', createHabit(core, { id: 'h-b', name: `${CANARY} other`, kind: 'tri', days: [1, 3], asked: 'morning', target: {}, tier: 'log', replaces: 'h-a' }));
  await must('edit', editHabit(core, { id: 'h-a', name: `${CANARY} renamed`, sub: `${CANARY} sub 2`, target: {}, order: 3, days: [1, 2, 3], asked: 'evening' }));
  await must('swap', swapFocus(core, { into: 'h-b', out: 'h-a' }));
  await must('retire', retireHabit(core, { id: 'h-b' }));
  await must('return', returnHabit(core, { id: 'h-b' }));
  await must('settle', settleHabit(core, { id: 'h-b' }));
  await must('log', logObservation(core, { habitId: 'h-a', date: '2026-01-07', value: 'did' }));
  await must('backfill', logObservation(core, { habitId: 'h-a', date: '2026-01-06', value: 'partly' }));
  await must('plan', planDay(core, { date: '2026-01-08', plans: [{ habitId: 'h-a', reason: 'travelling' }], restDay: true }));
  await must('day words', saveDayWords(core, { date: '2026-01-07', intent: `${CANARY} intent`, remark: `${CANARY} remark`, badNightNote: `${CANARY} night` }));
  await must('close', closeDay(core, { date: '2026-01-07', lightsOut: 1400 }));
  await must('reopen', reopenDay(core, { date: '2026-01-07' }));
  await must('clear', clearObservation(core, { habitId: 'h-a', date: '2026-01-06' }));
  await must('page', saveEntry(core, { id: 'e-a', body: `${CANARY} page` }));
  await must('trash page', trashEntry(core, { id: 'e-a' }));
  await must('restore page', restoreEntry(core, { id: 'e-a' }));
  await must('page to wipe', saveEntry(core, { id: 'e-b', body: `${CANARY} wiped page` }));
  await must('trash it', trashEntry(core, { id: 'e-b' }));
  await must('not yet', saveNotYet(core, { id: 'n-a', text: `${CANARY} later`, why: `${CANARY} why`, startedAt: clock.now() }));
  await must('trash not yet', trashNotYet(core, { id: 'n-a' }));
  await must('restore not yet', restoreNotYet(core, { id: 'n-a' }));
  await must('private reminder', saveCue(core, { id: 'c-p', habitId: null, kind: 'checkin', text: `${CANARY} private`, times: { at: [600] }, enabled: true, private: true }));
  await must('reminder', saveCue(core, { id: 'c-b', habitId: 'h-a', kind: 'cue', text: `${CANARY} shown`, times: { at: [700] }, fade: { afterDays: 7, to: [700] }, enabled: false, private: false }));
  await must('delete reminder', deleteCue(core, { id: 'c-a' }));
  await must('review', saveReview(core, { period: 'week', start: '2026-01-05', answers: { went: `${CANARY} went` }, close: true }));
  await must('setting', setSetting(core, 'contact', `${CANARY} contact 2`));
  await must('bad-night note', setSetting(core, 'badNightNote', `${CANARY} bad night`));
  const changed = await changePassphrase(await rowsNow(core), PASS, NEXT.text, systemRandom, clock.now());
  if (changed.kind !== 'Done') throw new Error(changed.kind);
  await must('passphrase change', replaceWrapper(core, changed.value));
  assert.equal(await close(), 'written');

  // a week on: the trash is wiped at unlock, and the first snapshot of the new day keeps the old one in older/
  clock.set('2026-01-15T09:00:00Z');
  const opened = await unlockWithSecret(await rowsNow(core), NEXT);
  if (opened.kind !== 'Unlocked') throw new Error(opened.kind);
  const again = recording(sessionCiphers(opened.keys).cipher);
  const unlockAgain = () => openSession(core, again.cipher, sessionCiphers(opened.keys).backup);
  await unlockAgain();
  await must('another page', saveEntry(core, { id: 'e-c', body: `${CANARY} new day` }));
  const exported = await exportBackup(core, { appVersion: '0.1.0' });
  if (exported.kind !== 'Saved') throw new Error(exported.kind);
  assert.equal(await close(), 'written');

  // "replace everything" keeps a safety copy; a payload migration seals again; a schema upgrade keeps a raw copy
  await unlockAgain();
  assert.deepEqual(await restore(core, { file: exported.value.bytes, secret: NEXT, backupCipher: backupCipher(), replace: { files: m.files, appVersion: '0.1.0' } }), { kind: 'Restored' });
  await runMigrations(core, again.cipher, [TEST_V2]);
  db.close();
  const upgraded = await openStorage(deps, m.files, clock.now, TEST_SCHEMAS);
  if (upgraded.kind !== 'Ready') throw new Error(upgraded.kind);

  // every locked field was reached, and every free-text field carried the canary
  const reached = new Set([...rec.reached, ...again.reached]);
  const expected = Object.entries(LOCKED).flatMap(([table, slots]) =>
    (['r', 'w'] as const).flatMap(slot => slots[slot].map(field => `${TABLE_TAGS[table as keyof typeof TABLE_TAGS]}.${slot}.${field}`)));
  assert.deepEqual(expected.filter(f => !reached.has(f)).sort(), Object.keys(NOT_WRITTEN_YET).sort(), 'locked fields no write path reached');
  const carried = new Set([...rec.carried, ...again.carried]);
  assert.deepEqual(TEXT_FIELDS.filter(f => !carried.has(f)), [], 'text fields that never carried the canary');

  // found nowhere: not the canary, not either passphrase, not the recovery code in any spelling
  const secrets = [CANARY, made.recoveryCode, made.recoveryCode.replaceAll(' ', '')];
  const places = [
    ...(await storedBytes(upgraded.db)),
    { where: 'the export', bytes: exported.value.bytes },
    ...(await fileBytes('the export', exported.value.bytes, NEXT)).slice(1),
  ];
  for (const [path, bytes] of m.store) places.push(...(await fileBytes(path, bytes, NEXT)));
  assert.ok([...m.store.keys()].some(p => p.startsWith('backup/older/')), 'an older snapshot was kept');
  assert.ok([...m.store.keys()].some(p => p.startsWith('safety/')), 'a safety copy was kept');
  assert.ok([...m.store.keys()].some(p => p.startsWith('preupgrade/')), 'an upgrade copy was kept');
  const found = places.flatMap(p => leaks(p.bytes, secrets).map(hit => `${p.where}: ${hit}`));
  assert.deepEqual(found, []);
});

test('nothing in src/ uses the browser\'s other stores: no localStorage, sessionStorage or caches', () => {
  const src = join(import.meta.dirname, '..', '..', 'src');
  const files = (dir: string): string[] => readdirSync(dir).flatMap(name => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? files(p) : /\.(ts|tsx)$/.test(name) ? [p] : [];
  });
  const named = files(src).filter(f => /\b(?:localStorage|sessionStorage|caches)\b/.test(readFileSync(f, 'utf8')));
  assert.deepEqual(named, []);
});

// ── Review R3: the search itself, pinned, so weakening it fails here.

test('R3-6: the search undoes base64url inside a file too: UTF-16 of the canary, wrapped, is found only once the copy is opened', async () => {
  const wrapped = Buffer.from(CANARY, 'utf16le').toString('base64url');
  const copy = await gzip(Buffer.from(JSON.stringify({ entries: [{ id: 'e-gone', w: { v: 1, k: 'k', iv: 'iv', ct: wrapped } }] })));
  const places = await fileBytes('safety/old.gz', copy, PASS);
  assert.deepEqual(leaks(places[0]!.bytes, [CANARY]), []);                       // the file as kept hides it
  assert.deepEqual(leaks(places[1]!.bytes, [CANARY]), []);                       // and so does the copy unzipped
  assert.ok(places.some(p => leaks(p.bytes, [CANARY]).length > 0));             // a value inside it gives it away
});

test('R3-6: a planted leak, base64url of the canary, is found in the bytes as kept', () => {
  assert.ok(leaks(Buffer.from(Buffer.from(`x${CANARY}`).toString('base64url')), [CANARY]).length > 0);
  assert.ok(leaks(Buffer.from(`x${CANARY}`, 'utf16le'), [CANARY]).length > 0);
});

test('R3-7: the fields exempted from the canary are pinned: adding one fails here, and the list can only shrink', () => {
  assert.deepEqual(Object.keys(NOT_WRITTEN_YET), []);
});
