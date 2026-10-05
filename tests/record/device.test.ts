import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DISPLAY_DEFAULT, readDisplay, writeDisplay } from '../../src/record/ops/device.ts';
import { freshDb } from './helpers.ts';

test('display: the default until set, then what was saved; contrast stays within 60 to 160', async () => {
  const db = freshDb();
  assert.deepEqual(await readDisplay(db), DISPLAY_DEFAULT);
  await writeDisplay(db, { contrast: 0.7, dim: true });
  assert.deepEqual(await readDisplay(db), { contrast: 0.7, dim: true });
  await writeDisplay(db, { contrast: 3, dim: false });
  assert.equal((await readDisplay(db)).contrast, 1.6);
});
