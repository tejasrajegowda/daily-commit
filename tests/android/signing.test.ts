import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { APP_VERSION } from '../../src/app/compose.ts';
import { keytoolSha256, propertiesText, signersOf, signingPathOf, versionCodeOf, withSigningLine } from '../../scripts/android/signing.ts';

test('the version code rule: major × 10000 + minor × 100 + patch', () => {
  assert.equal(versionCodeOf('0.1.0'), 100);
  assert.equal(versionCodeOf('0.1.1'), 101);
  assert.equal(versionCodeOf('1.2.3'), 10203);
  for (const bad of ['1.2', '1.100.0', '1.2.100', 'v1.2.3', '']) assert.throws(() => versionCodeOf(bad), bad);
});

test('the app says the version package.json says, and Gradle computes the same code from it', () => {
  const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version: string };
  assert.equal(APP_VERSION, pkg.version);
  const gradle = readFileSync(new URL('../../android/app/build.gradle', import.meta.url), 'utf8');
  assert.match(gradle, /versionCode vMajor \* 10000 \+ vMinor \* 100 \+ vPatch/);
  assert.match(gradle, /versionName appVersion/);
});

test('Gradle reads the key only through the ignored local file; the repo holds no password and no key path', () => {
  const gradle = readFileSync(new URL('../../android/app/build.gradle', import.meta.url), 'utf8');
  assert.match(gradle, /getProperty\('dailycommit\.signing'\)/);
  assert.doesNotMatch(gradle, /storePassword\s+['"]/);
  assert.doesNotMatch(gradle, /\.jks/);
});

test('apksigner\'s and keytool\'s fingerprints are read the same way', () => {
  const hex = 'ab'.repeat(32);
  assert.deepEqual(signersOf(`Signer #1 certificate DN: CN=Daily Commit\nSigner #1 certificate SHA-256 digest: ${hex}\nSigner #1 certificate SHA-1 digest: 00\n`), [hex]);
  assert.deepEqual(signersOf(`Signer #1 certificate SHA-256 digest: ${hex}\nSigner #2 certificate SHA-256 digest: ${'cd'.repeat(32)}\n`).length, 2);
  assert.equal(keytoolSha256(`Certificate fingerprints:\n\t SHA1: 00:11\n\t SHA256: ${Array.from({ length: 32 }, () => 'AB').join(':')}\n`), hex);
});

// The paths below are invented examples of the shape, not a real folder.
test('the properties file uses forward slashes and one password; local.properties keeps its other lines', () => {
  const text = propertiesText('C:\\keys\\dc\\daily-commit.jks', 'p4ss');
  assert.match(text, /^storeFile=C:\/keys\/dc\/daily-commit\.jks$/m);
  assert.match(text, /^storePassword=p4ss$/m);
  assert.match(text, /^keyPassword=p4ss$/m);
  assert.match(text, /^keyAlias=daily-commit$/m);
  const local = withSigningLine('sdk.dir=C\\:\\\\Sdk\n', 'C:\\keys\\dc\\keystore.properties');
  assert.match(local, /^sdk\.dir=/m);
  assert.equal(signingPathOf(local), 'C:/keys/dc/keystore.properties');
  assert.equal(signingPathOf(withSigningLine(local, 'D:/other/keystore.properties')), 'D:/other/keystore.properties');   // replaced, not added twice
});
