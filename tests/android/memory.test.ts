import { test } from 'node:test';
import assert from 'node:assert/strict';
import { countHeavy, GB, mayStart } from '../../scripts/android/memory.ts';

test('a Gradle client or a Kotlin daemon is a build; an idle Gradle daemon is not; qemu and emulator are emulators', () => {
  assert.deepEqual(countHeavy([
    { name: 'java.exe', commandLine: 'java -jar gradle\\wrapper\\gradle-wrapper.jar assembleRelease' },
    { name: 'java.exe', commandLine: 'java -cp x org.gradle.wrapper.GradleWrapperMain build' },
    { name: 'java.exe', commandLine: 'java -cp x org.jetbrains.kotlin.daemon.KotlinCompileDaemon' },
    { name: 'java.exe', commandLine: 'java -cp x org.gradle.launcher.daemon.bootstrap.GradleDaemon 8.14.3' },
    { name: 'qemu-system-x86_64.exe', commandLine: 'qemu' },
    { name: 'emulator.exe', commandLine: 'emulator -avd omni-api33' },
    { name: 'java.exe', commandLine: 'java -jar some-other-tool.jar' },
  ]), { gradleBuilds: 3, emulators: 2 });
});

test('Gradle needs 4 GB free, the emulator 6 GB, and neither starts while anything else heavy runs, in either project', () => {
  assert.deepEqual(mayStart('gradle', { freeBytes: 4 * GB, gradleBuilds: 0, emulators: 0 }), { ok: true });
  assert.equal(mayStart('gradle', { freeBytes: 3.9 * GB, gradleBuilds: 0, emulators: 0 }).ok, false);
  assert.equal(mayStart('gradle', { freeBytes: 9 * GB, gradleBuilds: 1, emulators: 0 }).ok, false);
  assert.equal(mayStart('gradle', { freeBytes: 9 * GB, gradleBuilds: 0, emulators: 1 }).ok, false);
  assert.equal(mayStart('emulator', { freeBytes: 5 * GB, gradleBuilds: 0, emulators: 0 }).ok, false);
  assert.equal(mayStart('emulator', { freeBytes: 5.9 * GB, gradleBuilds: 0, emulators: 0 }).ok, false);
  assert.equal(mayStart('emulator', { freeBytes: 9 * GB, gradleBuilds: 1, emulators: 0 }).ok, false);
  assert.equal(mayStart('emulator', { freeBytes: 6 * GB, gradleBuilds: 0, emulators: 0 }).ok, true);
});

test('the reason names only counts and amounts, never a process\'s command line', () => {
  const r = mayStart('gradle', { freeBytes: 3 * GB, gradleBuilds: 1, emulators: 0 });
  assert.ok(!r.ok && /^[0-9 .,a-zA-Z()]+$/.test(r.why), r.ok ? '' : r.why);
});
