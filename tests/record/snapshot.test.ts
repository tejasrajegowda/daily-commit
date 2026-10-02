import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { BackupCipher } from '../../src/vault/cipher.ts';
import type { RecordCore } from '../../src/record/core.ts';
import type { SnapshotFiles } from '../../src/record/files.ts';
import { closeSession, openSession } from '../../src/record/ops/session.ts';
import { setSetting } from '../../src/record/ops/settings.ts';
import { readFrame } from '../../src/record/backup/format.ts';
import { LATEST, SNAPSHOT_CAP_MS } from '../../src/record/backup/snapshot.ts';
import { filledRecord, openedRecord } from './helpers.ts';
import { memoryFiles } from './memoryFiles.ts';
import { STUB_SECRETS, stubBackup } from './stubBackup.ts';
import { stubCipher } from './stubCipher.ts';
import { guarded, guardedBackup } from './txGuard.ts';

const never = () => new Promise<void>(() => {});
const reopen = (core: RecordCore, backup: BackupCipher = stubBackup()) => openSession(core, guarded(stubCipher()), guardedBackup(backup));
const closer = (core: RecordCore, files: SnapshotFiles) => () => closeSession(core, { files, sleep: never, appVersion: '0.1.0' });
const changes = (log: readonly string[]) => log.filter(call => !call.startsWith('read ') && !call.startsWith('list '));

test('lock hands beforeDrop the open record, and drops it even when beforeDrop fails', async () => {
  const { core } = await openedRecord();
  assert.equal(await core.lock(async s => s.model.settings.boundary), 240);
  assert.equal(core.session, undefined);
  assert.equal(await core.lock(async () => 1), undefined);                 // nothing open: it never runs
  await core.unlock(guarded(stubCipher()));
  await assert.rejects(core.lock(async () => { throw new Error('boom'); }), /boom/);
  assert.equal(core.session, undefined);
});

test('the first lock seals a snapshot with the keys in memory, drops them, then writes it through tmp/', async () => {
  const { core } = await filledRecord();
  const m = memoryFiles();
  const seen: string[] = [];
  const backup = stubBackup();
  await core.lock();
  await reopen(core, { ...backup, sealBody: (body, header, iv) => { seen.push(core.session ? 'sealed while open' : 'sealed after lock'); return backup.sealBody(body, header, iv); } });
  const files: SnapshotFiles = { ...m.files, write: (path, bytes) => { seen.push(core.session ? 'written while open' : 'written after lock'); return m.files.write(path, bytes); } };
  assert.equal(await closer(core, files)(), 'written');
  assert.deepEqual(seen, ['sealed while open', 'written after lock']);
  assert.equal(core.session, undefined);
  assert.deepEqual(changes(m.log), ['write tmp/snapshot.dcbak', 'rename tmp/snapshot.dcbak backup/latest.dcbak']);
  assert.deepEqual([...m.store.keys()], [LATEST]);
  const f = readFrame(m.store.get(LATEST) ?? new Uint8Array());
  await assert.doesNotReject(stubBackup().openBody(f.headerBytes, f.iv, f.ct, f.header.wrappers, { method: 'passphrase', text: STUB_SECRETS.passphrase }));
});

test('a lock with nothing new writes nothing, and the next change is written again', async () => {
  const { core } = await filledRecord();
  const m = memoryFiles();
  const close = closer(core, m.files);
  assert.equal(await close(), 'written');
  assert.equal(await close(), 'unchanged');                                // nothing open
  await reopen(core);
  assert.equal(await close(), 'unchanged');                                // opened and closed, nothing changed
  await reopen(core);
  assert.equal((await setSetting(core, 'wakePlan', 400)).kind, 'Saved');
  assert.equal(await close(), 'written');
  assert.equal(changes(m.log).length, 4);
});

test('a clock set back a day changes nothing: no false change, no rotation, and the next change is still seen', async () => {
  const { core, clock } = await filledRecord();
  const m = memoryFiles();
  const close = closer(core, m.files);
  await close();
  clock.advance(-86_400_000);
  await reopen(core);
  assert.equal(await close(), 'unchanged');
  await reopen(core);
  await setSetting(core, 'wakePlan', 400);
  assert.equal(await close(), 'written');
  assert.deepEqual([...m.store.keys()], [LATEST]);                         // the day never went back, so nothing moved
});

test('the first snapshot of a new app day keeps the last one in older/, which holds three', async () => {
  const { core, clock } = await filledRecord();                            // the clock reads 2026-01-06 20:00
  const m = memoryFiles();
  const close = closer(core, m.files);
  await close();
  const later = ['2026-01-06T21:00:00Z', '2026-01-07T20:00:00Z', '2026-01-08T20:00:00Z', '2026-01-09T20:00:00Z', '2026-01-10T20:00:00Z'];
  for (const [i, iso] of later.entries()) {
    clock.set(iso);
    await reopen(core);
    await setSetting(core, 'wakePlan', 400 + i);
    assert.equal(await close(), 'written', iso);
    if (i === 0) assert.deepEqual([...m.store.keys()], [LATEST], 'a second snapshot the same day only replaces latest');
  }
  assert.deepEqual([...m.store.keys()].filter(p => p !== LATEST).sort(), ['backup/older/2026-01-07.dcbak', 'backup/older/2026-01-08.dcbak', 'backup/older/2026-01-09.dcbak']);
  const kept = readFrame(m.store.get('backup/older/2026-01-09.dcbak') ?? new Uint8Array()).header;
  assert.equal(new Date(kept.exported_at).toISOString().slice(0, 10), '2026-01-09');
});

test('a snapshot past 3 seconds is abandoned: the keys still drop, nothing is written, and the next lock tries again', async () => {
  const { core } = await filledRecord();
  await core.lock();
  await reopen(core, { ...stubBackup(), sealBody: () => new Promise<Uint8Array>(() => {}) });     // never answers
  const m = memoryFiles();
  const asked: number[] = [];
  assert.equal(await closeSession(core, { files: m.files, sleep: async ms => { asked.push(ms); }, appVersion: '0.1.0' }), 'abandoned');
  assert.deepEqual(asked, [3000]);
  assert.equal(SNAPSHOT_CAP_MS, 3000);
  assert.equal(core.session, undefined);
  assert.deepEqual(changes(m.log), []);
  await reopen(core);
  assert.equal(await closer(core, m.files)(), 'written');
});

test('a file that fails to write is reported; the keys drop anyway, the last good copy stays, and the next lock retries', async () => {
  const { core } = await filledRecord();
  const m = memoryFiles();
  const close = closer(core, m.files);
  await close();
  const good = m.store.get(LATEST);
  await reopen(core);
  await setSetting(core, 'wakePlan', 400);
  m.failOn('rename tmp/snapshot.dcbak');
  assert.equal(await close(), 'failed');
  assert.equal(core.session, undefined);
  assert.deepEqual(m.store.get(LATEST), good);
  m.failOn(undefined);
  await reopen(core);
  assert.equal(await close(), 'written');
  assert.notDeepEqual(m.store.get(LATEST), good);
});

test('a damaged latest.dcbak is replaced at the next lock, and never kept in older/', async () => {
  const { core, clock } = await filledRecord();
  const m = memoryFiles();
  m.store.set(LATEST, Uint8Array.of(1, 2, 3));
  clock.advance(86_400_000);                                               // even on a later day
  assert.equal(await closer(core, m.files)(), 'written');
  assert.deepEqual([...m.store.keys()], [LATEST]);
  assert.doesNotThrow(() => readFrame(m.store.get(LATEST) ?? new Uint8Array()));
});
