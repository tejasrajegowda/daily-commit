import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { APP_VERSION } from '../../src/app/compose.ts';
import { versionCodeOf } from '../../scripts/android/signing.ts';
import { CHANGES, changesFrom } from '../../src/settings/whatChanged.ts';

test('RF5: the running version has a line', () => {
  const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version: string };
  assert.equal(changesFrom(APP_VERSION)[0]?.version, APP_VERSION);
  assert.equal(changesFrom(pkg.version)[0]?.version, pkg.version);
});

test('newest first, each version once, each a real version', () => {
  const versions = CHANGES.map(change => change.version);
  assert.equal(new Set(versions).size, versions.length);
  for (const version of versions) assert.match(version, /^\d+\.\d+\.\d+$/);
  const codes = versions.map(version => versionCodeOf(version));
  for (let i = 1; i < codes.length; i++) {
    const newer = codes[i - 1];
    const older = codes[i];
    assert.ok(newer !== undefined && older !== undefined && newer > older);
  }
});

test('the lines are short and plain', () => {
  for (const { line } of CHANGES) {
    assert.ok(line.length >= 1 && line.length <= 120, line);
    assert.equal(line.endsWith('.'), true, line);
    assert.equal(/[!%]/.test(line), false, line);
  }
});

test('a version not in the list shows nothing rather than a wrong line', () => {
  assert.deepEqual(changesFrom('9.9.9'), []);
});
