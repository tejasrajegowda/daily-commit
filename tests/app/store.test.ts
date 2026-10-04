import { test } from 'node:test';
import assert from 'node:assert/strict';
import { recordStore } from '../../src/app/store.ts';
import { createHabit } from '../../src/record/ops/habits.ts';
import { invalid, locked, quotaFull, sealed, type Result } from '../../src/record/results.ts';
import { openedRecord } from '../record/helpers.ts';

const WALK = { id: 'h-walk', name: 'CANARY-TEST walk', kind: 'tri', days: [0, 1, 2, 3, 4, 5, 6], asked: 'evening', target: {}, tier: 'log' } as const;

test('a Saved write moves the revision on once and tells every listener', async () => {
  const { core } = await openedRecord();
  const store = recordStore(core);
  let heard = 0;
  store.subscribe(() => { heard++; });
  store.subscribe(() => { heard++; });
  const before = store.revision();
  const result = await store.run(c => createHabit(c, WALK));
  assert.equal(result.kind, 'Saved');
  assert.equal(store.revision(), before + 1);
  assert.equal(heard, 2);
});

test('a refused write (Sealed, Invalid, QuotaFull, Locked) leaves the revision where it was and tells no one', async () => {
  const { core } = await openedRecord();
  const store = recordStore(core);
  let heard = 0;
  store.subscribe(() => { heard++; });
  for (const refusal of [sealed(), invalid('no'), quotaFull(), locked()] as Result<void>[]) {
    assert.deepEqual(await store.run(async () => refusal), refusal);
  }
  assert.equal(store.revision(), 0);
  assert.equal(heard, 0);
});

test('changed() moves it on, and a listener that stopped listening hears nothing more', async () => {
  const { core } = await openedRecord();
  const store = recordStore(core);
  let heard = 0;
  const stop = store.subscribe(() => { heard++; });
  store.changed();
  stop();
  store.changed();
  assert.equal(store.revision(), 2);
  assert.equal(heard, 1);
});

test('a listener that throws never stops the others hearing', async () => {
  const { core } = await openedRecord();
  const store = recordStore(core);
  let heard = 0;
  store.subscribe(() => { throw new Error('a screen failed to draw'); });
  store.subscribe(() => { heard++; });
  store.changed();
  assert.equal(heard, 1);
});
