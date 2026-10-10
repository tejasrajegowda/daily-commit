import { test } from 'node:test';
import assert from 'node:assert/strict';
import { duringHandOff, takeHandOff } from '../../src/app/handOff.ts';
import { readHandOff } from '../../src/record/ops/device.ts';
import { testDeps } from './deps.ts';
import { realRecord } from './realRecord.ts';

const tick = () => new Promise<void>(done => setImmediate(done));

test('a system screen the app opens is marked, kind only, and the mark goes when it comes back', async () => {
  const r = await realRecord();
  const { deps } = testDeps(r.core);
  let during: unknown;
  assert.equal(await duringHandOff(deps, 'export', async () => { during = await r.core.db.device.get('handoff'); return 'saved'; }), 'saved');
  assert.deepEqual(during, { key: 'handoff', value: 'export' });
  assert.equal(await readHandOff(r.core.db), undefined);
  await assert.rejects(duringHandOff(deps, 'restore', async () => { throw new Error('the picker failed'); }));
  assert.equal(await readHandOff(r.core.db), undefined);                   // gone whatever the outcome
});

test('R-3: when Android ended the app during it, the next start finds the kind, once', async () => {
  const r = await realRecord();
  void duringHandOff(testDeps(r.core).deps, 'fingerprint', () => new Promise<never>(() => {}));   // never comes back
  await tick();
  const next = testDeps(r.core).deps;                                      // the app started again on the same storage
  assert.equal(await takeHandOff(next), 'fingerprint');
  assert.equal(await takeHandOff(next), undefined);
});

test('a browser never marks: a closed tab is not Android ending the app', async () => {
  const r = await realRecord();
  const { deps } = testDeps(r.core, { deviceModes: false });
  await duringHandOff(deps, 'export', async () => { assert.equal(await readHandOff(r.core.db), undefined); });
});
