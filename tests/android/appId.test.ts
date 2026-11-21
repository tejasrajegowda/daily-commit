import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ACTIVITY, RELEASE_ID, TESTS_ID, dataDir, focusPattern, focusRegExp, startCommand, testsBuild } from '../../scripts/android/appId.ts';

test('the tests build is chosen by DC_TESTS_BUILD=1 or a tests flag, and by nothing else', () => {
  assert.equal(testsBuild([], {}), false);
  assert.equal(testsBuild(['node', 'x.ts', '--owner'], {}), false);
  assert.equal(testsBuild(['node', 'x.ts'], { DC_TESTS_BUILD: '0' }), false);
  assert.equal(testsBuild(['node', 'x.ts', '--testsx'], {}), false);
  assert.equal(testsBuild(['node', 'x.ts'], { DC_TESTS_BUILD: '1' }), true);
  for (const flag of ['--tests', '--tablet', '--tests-build']) assert.equal(testsBuild(['node', 'x.ts', flag], {}), true, flag);
});

test('the two ids differ, and the tests id is the release id with .tests', () => {
  assert.equal(TESTS_ID, `${RELEASE_ID}.tests`);
});

test('a start command names the launcher screen in full, in both builds', () => {
  assert.equal(ACTIVITY, 'app.dailycommit.MainActivity');
  assert.equal(startCommand(RELEASE_ID, false), 'am start -n app.dailycommit/app.dailycommit.MainActivity');
  assert.equal(startCommand(TESTS_ID, true), 'am start -W -n app.dailycommit.tests/app.dailycommit.MainActivity');
});

test('one id\'s focus pattern never matches the other id\'s window', () => {
  const release = 'mCurrentFocus=Window{1a2b u10 app.dailycommit/app.dailycommit.MainActivity}';
  const tests = 'mCurrentFocus=Window{1a2b u10 app.dailycommit.tests/app.dailycommit.MainActivity}';
  assert.match(release, focusRegExp(RELEASE_ID));
  assert.doesNotMatch(tests, focusRegExp(RELEASE_ID));
  assert.match(tests, focusRegExp(TESTS_ID));
  assert.doesNotMatch(release, focusRegExp(TESTS_ID));
  assert.doesNotMatch('mCurrentFocus=Window{9 u0 app.dailycommitx/app.dailycommitx.Main}', focusRegExp(RELEASE_ID));
  // the device-side text is the same pattern, for grep -E
  assert.equal(focusPattern(RELEASE_ID), String.raw`[ {]app\.dailycommit/`);
  assert.equal(focusPattern(TESTS_ID), String.raw`[ {]app\.dailycommit\.tests/`);
});

test('the data folder follows the id', () => {
  assert.equal(dataDir(TESTS_ID), '/data/user/0/app.dailycommit.tests');
});

test('the id has one source: no script names it or a relative launcher screen in code', async () => {
  const { readdirSync, readFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const root = new URL('../../scripts/android/', import.meta.url);
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) walk(join(dir, e.name));
      else if (e.name.endsWith('.ts') && e.name !== 'appId.ts') files.push(join(dir, e.name));
    }
  };
  walk((await import('node:url')).fileURLToPath(root));
  assert.ok(files.length > 10);
  for (const f of files) {
    // comments and plain-language messages may name the ids; code may not
    const code = readFileSync(f, 'utf8').split(/\r?\n/).filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n')
      .replace(/'[^'\n]*Nothing was installed\.'/g, '')
      .replace(/'app\.dailycommit\.PrivateWebView'|layout\\'s web view is not app\.dailycommit\.PrivateWebView/g, '');
    assert.doesNotMatch(code, /app\.dailycommit/, f);
    assert.doesNotMatch(code, /\/\.MainActivity/, f);
  }
});
