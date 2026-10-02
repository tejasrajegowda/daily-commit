import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeQueue } from '../../src/record/queue.ts';

test('jobs run one at a time, in order, even when the first is slow', async () => {
  const run = writeQueue();
  const log: string[] = [];
  const a = run(async () => { log.push('a starts'); await new Promise(r => setTimeout(r, 20)); log.push('a ends'); return 'a'; });
  const b = run(async () => { log.push('b starts'); log.push('b ends'); return 'b'; });
  assert.deepEqual(await Promise.all([a, b]), ['a', 'b']);
  assert.deepEqual(log, ['a starts', 'a ends', 'b starts', 'b ends']);
});

test('a job that fails does not stop the one after it', async () => {
  const run = writeQueue();
  const a = run(async () => { throw new Error('boom'); });
  const b = run(async () => 'b');
  await assert.rejects(a, /boom/);
  assert.equal(await b, 'b');
});
