import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { policyProblems, releaseProblems } from '../../scripts/release-check.ts';

const CSP = `<meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self'">`;
const clean = () => new Map([
  ['index.html', `<!doctype html><html><head>${CSP}<script type="module" crossorigin src="./assets/index-a1.js"></script><link rel="stylesheet" href="./assets/index-b2.css"></head><body><div id="root"></div></body></html>`],
  ['assets/index-a1.js', 'console.log(1)'],
]);

test('a clean build has no problems', () => {
  assert.deepEqual(releaseProblems(clean()), []);
});

test('a harness file, a harness string, the stand-in plugin or an invented secret in the build are each refused', () => {
  for (const [path, text] of [['harness.html', '<html></html>'], ['assets/x.js', 'seedRecord()'], ['assets/y.js', 'fakePlugin'],
    ['assets/z.js', 'const p = "CANARY harness passphrase"'], ['assets/w.js', 'HARNESS_CODE']] as const) {
    const files = clean();
    files.set(path, text);
    assert.notDeepEqual(releaseProblems(files), [], path);
  }
});

test('an inline script, a style element, a style attribute or a missing content policy are refused', () => {
  for (const html of [`<html><head>${CSP}<script>alert(1)</script></head></html>`, `<html><head>${CSP}<style>a{}</style></head></html>`,
    `<html><head>${CSP}</head><body style="color:red"></body></html>`, '<html><head></head></html>']) {
    const files = clean();
    files.set('index.html', html);
    assert.notDeepEqual(releaseProblems(files), [], html);
  }
});

test("the app's own content policy passes", () => {
  assert.deepEqual(policyProblems(readFileSync('index.html', 'utf8').match(/Content-Security-Policy"\s+content="([^"]*)"/)?.[1] ?? 'missing'), []);
});

test('a policy that allows inline or eval code, or lets script or the network reach past the app, is refused', () => {
  for (const content of [
    "default-src 'self'; script-src 'self' 'unsafe-inline'",
    "default-src 'self'; script-src 'self' 'unsafe-eval'",
    "default-src 'self'; style-src 'self' 'unsafe-inline'",
    "default-src 'self'; connect-src *",
    "default-src 'self'; connect-src 'self' https:",
    "default-src 'self'; connect-src 'self' https://example.com",
    "default-src 'self'; script-src 'self' data:",
    "default-src *",
    "script-src 'self'",
  ]) {
    const files = clean();
    files.set('index.html', `<html><head><meta http-equiv="Content-Security-Policy" content="${content}"></head></html>`);
    assert.notDeepEqual(releaseProblems(files), [], content);
  }
});
