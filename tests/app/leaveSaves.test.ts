import { test } from 'node:test';
import assert from 'node:assert/strict';
import { leaveSaves } from '../../src/app/leaveSaves.ts';
import { lockMachine } from '../../src/app/lockMachine.ts';
import { recordStore } from '../../src/app/store.ts';
import type { RecordCore } from '../../src/record/core.ts';
import { saveEntry } from '../../src/record/ops/words.ts';
import type { Result } from '../../src/record/results.ts';
import { memoryFiles } from '../record/memoryFiles.ts';
import { fakePlugin } from '../vault/fakePlugin.ts';
import { PASSPHRASE, realRecord } from './realRecord.ts';

const sessionOf = (core: RecordCore) => core.session;

test('a leave runs every field save added, and none that has stopped', () => {
  const saves = leaveSaves();
  const ran: string[] = [];
  saves.add(() => ran.push('page'));
  const stop = saves.add(() => ran.push('line'));
  saves.add(() => ran.push('note'));
  stop();
  saves.run();
  assert.deepEqual(ran, ['page', 'note']);
});

test('a field save that throws never stops the others', () => {
  const saves = leaveSaves();
  const ran: string[] = [];
  saves.add(() => { throw new Error('CANARY-TEST'); });
  saves.add(() => ran.push('page'));
  assert.doesNotThrow(() => saves.run());
  assert.deepEqual(ran, ['page']);
});

test('the words in a field when the app is left are saved under the open session, ahead of the lock', async () => {
  const r = await realRecord();
  const machine = lockMachine({ core: r.core, plugin: fakePlugin().plugin, close: { files: memoryFiles().files, sleep: () => new Promise(() => {}), appVersion: '0.1.0' } });
  const store = recordStore(r.core);
  const saves = leaveSaves();
  const id = r.core.newId();
  let answer: Promise<Result<void>> | undefined;
  saves.add(() => { answer = store.run(c => saveEntry(c, { id, body: 'CANARY a page still being written' })); });
  saves.run();                                           // the app's leave runs the saves first
  const leaving = machine.leave();
  assert.equal((await answer)?.kind, 'Saved');
  assert.equal(await leaving, 'written');
  await machine.resume();
  assert.deepEqual(await machine.unlock({ method: 'passphrase', text: PASSPHRASE }), { kind: 'Open' });
  assert.equal(sessionOf(r.core)?.model.entries.get(id)?.body, 'CANARY a page still being written');
});
