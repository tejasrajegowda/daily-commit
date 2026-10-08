import { test } from 'node:test';
import assert from 'node:assert/strict';
import { junitSummary } from '../../scripts/android/build.ts';

test('the JUnit result files are added up', () => {
  const a = '<testsuite name="a" tests="12" skipped="0" failures="1" errors="0" time="0.1">';
  const b = '<testsuite name="b" tests="3" skipped="1" failures="0" errors="2" time="0.1">';
  assert.deepEqual(junitSummary([a, b]), { tests: 15, failures: 1, errors: 2, skipped: 1 });
  assert.deepEqual(junitSummary([]), { tests: 0, failures: 0, errors: 0, skipped: 0 });
});
