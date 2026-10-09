import { test } from 'node:test';
import assert from 'node:assert/strict';
import { apkProblems, type ApkView } from '../../scripts/android/apk-check.ts';

const CSP = `<meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self'; connect-src 'self'">`;
// The merged manifest as `apkanalyzer manifest print` shows it: the allowed permissions, AndroidX's own
// permission, and the notification plugin's receivers and providers closed to other apps.
const MANIFEST = `<manifest xmlns:android="http://schemas.android.com/apk/res/android" package="app.dailycommit">`
  + `<uses-permission android:name="android.permission.USE_EXACT_ALARM"/><uses-permission android:name="android.permission.POST_NOTIFICATIONS"/>`
  + `<uses-permission android:name="android.permission.RECEIVE_BOOT_COMPLETED"/>`
  + `<uses-permission android:name="android.permission.WAKE_LOCK"/>`
  + `<permission android:name="app.dailycommit.DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION" android:protectionLevel="0x2"/>`
  + `<uses-permission android:name="app.dailycommit.DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION"/>`
  + `<application android:label="@string/app_name" android:allowBackup="true" android:dataExtractionRules="@xml/data_extraction_rules" android:usesCleartextTraffic="false">`
  + `<activity android:name="app.dailycommit.MainActivity" android:exported="true"><intent-filter><action android:name="android.intent.action.MAIN"/></intent-filter></activity>`
  + `<receiver android:name="com.capacitorjs.plugins.localnotifications.TimedNotificationPublisher"/>`
  + `<receiver android:name="com.capacitorjs.plugins.localnotifications.LocalNotificationRestoreReceiver" android:exported="false"/>`
  + `<provider android:name="com.capacitorjs.plugins.localnotifications.LocalNotificationsAssetProvider" android:exported="false"/>`
  + `<provider android:name="androidx.startup.InitializationProvider" android:exported="false"/>`
  + `</application></manifest>`;
const CONFIG = JSON.stringify({ appId: 'app.dailycommit', appName: 'Daily Commit', webDir: 'dist', loggingBehavior: 'none',
  server: { androidScheme: 'https', hostname: 'localhost' }, android: { webContentsDebuggingEnabled: false, loggingBehavior: 'none', allowMixedContent: false } });
const RULES_OK = `<data-extraction-rules>
  <cloud-backup disableIfNoEncryptionCapabilities="true"><include domain="file" path="backup/latest.dcbak"/></cloud-backup>
  <device-transfer><include domain="file" path="backup/latest.dcbak"/></device-transfer>
  <cross-platform-transfer platform="ios"><exclude domain="root" path="."/><exclude domain="file" path="."/><exclude domain="database" path="."/><exclude domain="sharedpref" path="."/><exclude domain="external" path="."/><exclude domain="device_root" path="."/><exclude domain="device_file" path="."/><exclude domain="device_database" path="."/><exclude domain="device_sharedpref" path="."/></cross-platform-transfer>
</data-extraction-rules>`;
const LAYOUT_OK = `<androidx.coordinatorlayout.widget.CoordinatorLayout xmlns:android="http://schemas.android.com/apk/res/android">`
  + `<app.dailycommit.PrivateWebView android:id="@+id/webview" android:importantForAutofill="noExcludeDescendants" android:importantForContentCapture="noExcludeDescendants"/>`
  + `</androidx.coordinatorlayout.widget.CoordinatorLayout>`;
export const cleanApk = (): ApkView => ({
  manifest: MANIFEST,
  config: CONFIG,
  publicFiles: new Map([['index.html', `<html><head>${CSP}<script type="module" src="./assets/a.js"></script></head></html>`], ['assets/a.js', 'x']]),
  apkPublicList: ['assets/a.js', 'index.html'],
  resources: new Map([['res/xml/data_extraction_rules.xml', RULES_OK], ['res/layout/capacitor_bridge_layout_main.xml', LAYOUT_OK]]),
});
const withResource = (path: string, xml: string): ApkView => ({ ...cleanApk(), resources: new Map([...(cleanApk().resources ?? []), [path, xml]]) });
const withManifest = (f: (m: string) => string): ApkView => ({ ...cleanApk(), manifest: f(cleanApk().manifest) });

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

test('backup carries only backup/latest.dcbak, in both modes, only to a phone that encrypts it, and nothing to another platform', () => {
  assert.deepEqual(apkProblems(withResource('res/xml/data_extraction_rules.xml', RULES_OK)), []);
  for (const bad of [
    RULES_OK.replace(' disableIfNoEncryptionCapabilities="true"', ''),
    RULES_OK.replace(/<device-transfer>.*?<\/device-transfer>/s, ''),            // a missing section backs up everything
    RULES_OK.replace('path="backup/latest.dcbak"/></cloud-backup>', 'path="backup/latest.dcbak"/><include domain="file" path="backup/older"/></cloud-backup>'),
    RULES_OK.replace('<include domain="file" path="backup/latest.dcbak"/></device-transfer>', '<exclude domain="file" path="tmp"/></device-transfer>'),
    RULES_OK.replace(/<cross-platform-transfer.*?<\/cross-platform-transfer>/s, ''),
  ]) assert.notDeepEqual(apkProblems(withResource('res/xml/data_extraction_rules.xml', bad)), [], bad);
});

test('the old backup rules, cleartext, the exact-alarm request, internet, a file provider, a stray permission or backup switched off are refused', () => {
  for (const bad of [
    withManifest(m => m.replace('<application', '<uses-permission android:name="android.permission.INTERNET"/><application')),
    withManifest(m => m.replace('<application ', '<application android:fullBackupContent="@xml/backup_rules" ')),
    withManifest(m => m.replace('<application ', '<application android:usesCleartextTraffic="true" ')),
    withManifest(m => m.replace('<application', '<uses-permission android:name="android.permission.SCHEDULE_EXACT_ALARM"/><application')),
    withManifest(m => m.replace('<application', '<uses-permission android:name="android.permission.READ_CONTACTS"/><application')),
    withManifest(m => m.replace('</application>', '<provider android:name="androidx.core.content.FileProvider" android:exported="false"/></application>')),
    withManifest(m => m.replace('android:allowBackup="true"', 'android:allowBackup="false"')),
    withManifest(m => m.replace(' android:dataExtractionRules="@xml/data_extraction_rules"', '')),
  ]) assert.notDeepEqual(apkProblems(bad), [], bad.manifest);
});

test('only the launcher is open to other apps; a component behind the shell-only DUMP permission is allowed', () => {
  assert.notDeepEqual(apkProblems(withManifest(m => m.replace('</application>', '<receiver android:name="x.Y" android:exported="true"/></application>'))), []);
  assert.deepEqual(apkProblems(withManifest(m => m.replace('</application>', '<receiver android:name="androidx.profileinstaller.ProfileInstallReceiver" android:exported="true" android:permission="android.permission.DUMP"/></application>'))), []);
});

test('the web view is ours, with autofill and content capture off', () => {
  const at = 'res/layout/capacitor_bridge_layout_main.xml';
  assert.notDeepEqual(apkProblems(withResource(at, '<CoordinatorLayout><com.getcapacitor.CapacitorWebView android:id="@+id/webview"/></CoordinatorLayout>')), []);
  assert.notDeepEqual(apkProblems(withResource(at, '<CoordinatorLayout><app.dailycommit.PrivateWebView android:importantForContentCapture="8"/></CoordinatorLayout>')), []);
  assert.deepEqual(apkProblems(withResource(at, '<CoordinatorLayout><app.dailycommit.PrivateWebView android:importantForAutofill="0x8" android:importantForContentCapture="8"/></CoordinatorLayout>')), []);
});
