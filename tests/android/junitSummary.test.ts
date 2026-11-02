import { test } from 'node:test';
import assert from 'node:assert/strict';
import { failingTests, junitSummary } from '../../scripts/android/build.ts';

test('the JUnit result files are added up', () => {
  const a = '<testsuite name="a" tests="12" skipped="0" failures="1" errors="0" time="0.1">';
  const b = '<testsuite name="b" tests="3" skipped="1" failures="0" errors="2" time="0.1">';
  assert.deepEqual(junitSummary([a, b]), { tests: 15, failures: 1, errors: 2, skipped: 1 });
  assert.deepEqual(junitSummary([]), { tests: 0, failures: 0, errors: 0, skipped: 0 });
});

test('a failure is named as itself, not as the passing test before it', () => {
  // The shape Gradle writes: passing tests self-closed, a failing one with a body.
  const xml = '<testsuite name="s" tests="4" failures="2" errors="0">\n'
    + '  <testcase name="passesFirst" classname="x.WatchTest" time="0.001"/>\n'
    + '  <testcase name="failsSecond" classname="x.WatchTest" time="0.002">\n    <failure message="m">trace</failure>\n  </testcase>\n'
    + '  <testcase name="passesThird" classname="x.WatchTest" time="0.001"/>\n'
    + '  <testcase name="errsFourth" classname="x.WatchTest" time="0.001">\n    <error message="e">trace</error>\n  </testcase>\n'
    + '</testsuite>';
  assert.deepEqual(failingTests([xml]), ['x.WatchTest.failsSecond', 'x.WatchTest.errsFourth']);
  assert.deepEqual(failingTests(['<testsuite><testcase name="ok" classname="x.A"/></testsuite>']), []);
});
