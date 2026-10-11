import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installFailure, installOnPhone, USB_TIP, type Exec, type PhoneOptions } from '../../scripts/android/phone.ts';

const PIN = 'a'.repeat(64);
const OTHER = 'b'.repeat(64);
const PHONE = 'PHONE0000001';
const OPTS: PhoneOptions = { apk: 'out/app.apk', version: '0.1.0', pinnedCert: PIN, secondCopy: true };

/** A fake adb, apkanalyzer and apksigner: answers by command prefix, and records every call. */
function fake(over: Readonly<Record<string, string | undefined>> = {}) {
  const calls: string[][] = [];
  const answers: Record<string, string> = {
    'apkanalyzer manifest debuggable': 'false',
    'apkanalyzer manifest application-id': 'app.dailycommit',
    'apkanalyzer manifest version-code': '100',
    'apksigner verify --print-certs': `Signer #1 certificate DN: CN=Daily Commit\nSigner #1 certificate SHA-256 digest: ${PIN}\n`,
    'adb devices': `List of devices attached\n${PHONE}\tdevice\nemulator-5554\tdevice\n`,
    [`adb -s ${PHONE} shell dumpsys package app.dailycommit`]: 'Packages:\n  Package [app.dailycommit]\n    versionCode=100 minSdk=33 targetSdk=36\n',
    [`adb -s ${PHONE} install -r`]: 'Performing Streamed Install\nSuccess\n',
    'adb -s emulator-5556 shell dumpsys package app.dailycommit': '',
    'adb -s emulator-5556 install -r': 'Success\n',
  };
  for (const [key, value] of Object.entries(over)) if (value !== undefined) answers[key] = value;
  const exec: Exec = (tool, args) => {
    const line = [tool, ...args].join(' ');
    calls.push([tool, ...args]);
    const key = Object.keys(answers).filter(k => line.startsWith(k)).sort((a, b) => b.length - a.length)[0];
    return { code: 0, out: key === undefined ? '' : answers[key] ?? '' };
  };
  return { exec, calls };
}

test('a release build signed with the pinned key installs over what is there, with -r and nothing else, then the USB tip', () => {
  const f = fake();
  const out = installOnPhone(f.exec, OPTS);
  assert.ok(out.ok);
  assert.deepEqual(f.calls.filter(c => c.includes('install')), [['adb', '-s', PHONE, 'install', '-r', 'out/app.apk']]);
  if (out.ok) assert.ok(out.lines.includes(USB_TIP));
});

test('A1-24: never an uninstall, never -d, whatever happens', () => {
  const scenarios = [
    fake(), fake({ 'apkanalyzer manifest debuggable': 'true' }),
    fake({ [`adb -s ${PHONE} shell dumpsys package app.dailycommit`]: '    versionCode=200\n' }),
    fake({ [`adb -s ${PHONE} install -r`]: 'Failure [INSTALL_FAILED_UPDATE_INCOMPATIBLE: signatures do not match]\n' }),
  ];
  for (const f of scenarios) {
    installOnPhone(f.exec, OPTS);
    assert.ok(f.calls.every(c => !c.includes('uninstall') && !c.includes('-d') && !c.includes('pm')), JSON.stringify(f.calls));
  }
});

test('A3-13: only a release build', () => {
  const out = installOnPhone(fake({ 'apkanalyzer manifest debuggable': 'true' }).exec, OPTS);
  assert.equal(out.ok, false);
});

test('RF4: another signer, two signers, another app id, or no pinned key: nothing is installed', () => {
  for (const over of [
    { 'apksigner verify --print-certs': `Signer #1 certificate SHA-256 digest: ${OTHER}\n` },
    { 'apksigner verify --print-certs': `Signer #1 certificate SHA-256 digest: ${PIN}\nSigner #2 certificate SHA-256 digest: ${OTHER}\n` },
    { 'apkanalyzer manifest application-id': 'app.dailycommit.debug' },
  ]) {
    const f = fake(over);
    assert.equal(installOnPhone(f.exec, OPTS).ok, false);
    assert.ok(!f.calls.some(c => c.includes('install')));
  }
  assert.equal(installOnPhone(fake().exec, { ...OPTS, pinnedCert: '' }).ok, false);
});

test('C-23: the APK\'s version code must be package.json\'s; an older one is never put over a newer one; the same one reinstalls', () => {
  assert.equal(installOnPhone(fake({ 'apkanalyzer manifest version-code': '101' }).exec, OPTS).ok, false);
  const older = fake({ [`adb -s ${PHONE} shell dumpsys package app.dailycommit`]: '    versionCode=101\n' });
  const out = installOnPhone(older.exec, OPTS);
  assert.equal(out.ok, false);
  if (!out.ok) assert.match(out.why, /newer version/);
  assert.equal(installOnPhone(fake().exec, OPTS).ok, true);                     // 100 over 100
});

test('omnibus\'s emulator is never used; two phones need a name; an emulator only by name, and no USB tip for it', () => {
  assert.equal(installOnPhone(fake().exec, { ...OPTS, serial: 'emulator-5554' }).ok, false);
  assert.equal(installOnPhone(fake({ 'adb devices': `List\n${PHONE}\tdevice\nPHONE0000002\tdevice\n` }).exec, OPTS).ok, false);
  const emu = installOnPhone(fake({ 'adb devices': 'List\nemulator-5556\tdevice\n' }).exec, { ...OPTS, serial: 'emulator-5556', secondCopy: false });
  assert.ok(emu.ok);
  if (emu.ok) assert.ok(!emu.lines.includes(USB_TIP));
  assert.equal(installOnPhone(fake({ 'adb devices': 'List\nemulator-5556\tdevice\n' }).exec, OPTS).ok, false);   // never chosen by itself
});

test('R-2: the phone waits for the key\'s second copy', () => {
  const f = fake();
  const out = installOnPhone(f.exec, { ...OPTS, secondCopy: false });
  assert.equal(out.ok, false);
  if (!out.ok) assert.match(out.why, /second copy/);
  assert.ok(!f.calls.some(c => c.includes('install')));
});

test('a refusal from Android is said plainly, and an uninstall is never suggested as the fix', () => {
  assert.match(installFailure('Failure [INSTALL_FAILED_UPDATE_INCOMPATIBLE: x]'), /different key.*Do not uninstall/s);
  assert.match(installFailure('Failure [INSTALL_FAILED_VERSION_DOWNGRADE]'), /older/);
  assert.match(installFailure('Failure [INSTALL_FAILED_INSUFFICIENT_STORAGE]'), /space/);
  assert.match(installFailure('Failure [INSTALL_FAILED_USER_RESTRICTED]'), /phone blocked or cancelled/);
  assert.match(installFailure('something else'), /output is above/);
});
