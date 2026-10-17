import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { readBackupFile } from '../../src/app/restoreSteps.ts';
import { canaryHits } from '../../scripts/android/checks/canary.ts';
import { seed } from '../../scripts/android/checks/seed.ts';

test('the seed is a backup, the search finds a planted canary, and the backup holds none', async () => {
  const made = await seed(Date.parse('2026-06-01T12:00:00Z'), { shown: 60, private: 120 });
  assert.equal(readBackupFile(made.file).kind, 'File');
  assert.equal(made.habit, 'Walk');
  assert.equal(made.passphrase.startsWith('CANARY-'), true);
  const planted = Buffer.from(made.canaries.diary);
  assert.equal(canaryHits(planted, [made.canaries.diary]).some(h => h.form === 'utf8'), true);
  assert.deepEqual(canaryHits(made.file, Object.values(made.canaries)), []);
});
