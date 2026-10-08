import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { childEnv, missingTools, toolchain, toolPaths } from '../../scripts/android/env.ts';

const base = { LOCALAPPDATA: join('X', 'Local'), USERPROFILE: join('X', 'Home'), PATH: 'A;B' };

test('the JDK and the SDK come from the user\'s own folders, and an override wins', () => {
  assert.deepEqual(toolchain(base), { jdk: join('X', 'Local', 'Programs', 'jdk-21'), sdk: join('X', 'Home', 'Android', 'Sdk') });
  assert.equal(toolchain({ ...base, DC_ANDROID_SDK: join('Y', 'Sdk') }).sdk, join('Y', 'Sdk'));
  assert.throws(() => toolchain({ PATH: 'A' }));
});

test('a child gets JAVA_HOME, ANDROID_HOME and the tools first on PATH; the parent environment is not changed', () => {
  const tc = toolchain(base);
  const env = childEnv(tc, base);
  assert.equal(env.JAVA_HOME, tc.jdk);
  assert.equal(env.ANDROID_HOME, tc.sdk);
  assert.equal(env.ANDROID_SDK_ROOT, tc.sdk);
  const path = env.PATH ?? env.Path ?? '';
  assert.ok(path.startsWith(join(tc.jdk, 'bin')));
  assert.ok(path.endsWith('A;B'));
  assert.equal(process.env.JAVA_HOME === tc.jdk, false);
});

test('a missing platform or tool is named', () => {
  const tc = toolchain(base);
  const paths = toolPaths(tc);
  assert.deepEqual(missingTools(tc, p => p !== paths.platform), ['platform']);
  assert.deepEqual(missingTools(tc, () => true), []);
});
