import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { readBackupFile } from '../../src/app/restoreSteps.ts';
import { canaryHits } from '../../scripts/android/checks/canary.ts';
import { longRecord } from '../../scripts/android/checks/long.ts';

const NOW = Date.UTC(2026, 0, 31, 12);

test('the long record is a backup the app can read, and grows with its days', async () => {
  const short = await longRecord(NOW, 'UTC', 30);
  const longer = await longRecord(NOW, 'UTC', 60);
  assert.equal(short.days, 30);
  assert.equal(short.habits, 12);
  assert.equal(readBackupFile(short.file).kind, 'File');                             // FileRead's success kind
  assert.ok(longer.file.length > short.file.length);
});

test('its words are sealed: none is readable in the file in any form', async () => {
  const { file } = await longRecord(NOW, 'UTC', 30);
  assert.deepEqual(canaryHits(file, ['CANARY page', 'CANARY intent', 'CANARY habit']), []);
});

test('no time zone is written in the source; the CLI reads the machine\'s', () => {
  const src = readFileSync(new URL('../../scripts/android/checks/long.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /['"][A-Z][a-z]+\/[A-Z][A-Za-z_]+['"]/);
  assert.match(src, /resolvedOptions\(\)\.timeZone/);
});
