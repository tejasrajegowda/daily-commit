import { test } from 'node:test';
import assert from 'node:assert/strict';
import { releaseProblems } from '../../scripts/release-check.ts';

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
