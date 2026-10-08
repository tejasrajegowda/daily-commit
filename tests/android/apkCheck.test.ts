import { test } from 'node:test';
import assert from 'node:assert/strict';
import { apkProblems, type ApkView } from '../../scripts/android/apk-check.ts';

const CSP = `<meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self'; connect-src 'self'">`;
const MANIFEST = `<manifest xmlns:android="http://schemas.android.com/apk/res/android" package="app.dailycommit"><application android:label="@string/app_name"></application></manifest>`;
const CONFIG = JSON.stringify({ appId: 'app.dailycommit', appName: 'Daily Commit', webDir: 'dist', loggingBehavior: 'none',
  server: { androidScheme: 'https', hostname: 'localhost' }, android: { webContentsDebuggingEnabled: false, loggingBehavior: 'none', allowMixedContent: false } });
export const cleanApk = (): ApkView => ({
  manifest: MANIFEST,
  config: CONFIG,
  publicFiles: new Map([['index.html', `<html><head>${CSP}<script type="module" src="./assets/a.js"></script></head></html>`], ['assets/a.js', 'x']]),
  apkPublicList: ['assets/a.js', 'index.html'],
});

test('the clean APK has no problems', () => {
  assert.deepEqual(apkProblems(cleanApk()), []);
});

test('a debuggable build or another app id is refused', () => {
  assert.notDeepEqual(apkProblems({ ...cleanApk(), manifest: MANIFEST.replace('<application ', '<application android:debuggable="true" ') }), []);
  assert.notDeepEqual(apkProblems({ ...cleanApk(), manifest: MANIFEST.replace('app.dailycommit', 'app.dailycommit.dev') }), []);
});

test('a config with another scheme or hostname, a server url, debugging or logging is refused', () => {
  const edit = (f: (c: any) => void) => { const c = JSON.parse(CONFIG); f(c); return { ...cleanApk(), config: JSON.stringify(c) }; };
  for (const bad of [
    edit(c => { c.server.androidScheme = 'http'; }),
    edit(c => { c.server.hostname = 'app'; }),
    edit(c => { c.server.url = 'http://10.0.2.2:5173'; }),
    edit(c => { c.android.webContentsDebuggingEnabled = true; }),
    edit(c => { delete c.android.webContentsDebuggingEnabled; }),
    edit(c => { c.loggingBehavior = 'debug'; }),
    edit(c => { c.appId = 'app.other'; }),
  ]) assert.notDeepEqual(apkProblems(bad), [], bad.config);
});

test('the web assets go through the release check, and the APK must carry exactly what was synced', () => {
  const leaking = cleanApk();
  (leaking.publicFiles as Map<string, string>).set('assets/b.js', 'fakePlugin');
  assert.notDeepEqual(apkProblems(leaking), []);
  assert.notDeepEqual(apkProblems({ ...cleanApk(), apkPublicList: ['index.html'] }), []);
});
