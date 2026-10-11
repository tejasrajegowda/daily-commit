// Installs a release build onto one device. Only a build signed with the pinned certificate, only
// over what is already there (`adb install -r`), never -d, never an uninstall, never an older
// version over a newer one, never another project's emulator. A real phone waits until the key's
// second copy is recorded. Nothing of the device is printed but its serial.
// node scripts/android/phone.ts [--serial <serial>]
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { APP_ID, SIGNED_APK } from './apk-check.ts';
import { childEnv, toolchain, toolPaths } from './env.ts';
import { RELEASE_CERT_SHA256, SECOND_COPY, versionCodeOf, signersOf } from './signing.ts';

export type Tool = 'adb' | 'apkanalyzer' | 'apksigner';
export type Exec = (tool: Tool, args: readonly string[]) => { readonly code: number; readonly out: string };

export interface PhoneOptions {
  readonly apk: string;
  readonly serial?: string;
  readonly version: string;          // package.json's
  readonly pinnedCert: string;       // RELEASE_CERT_SHA256
  readonly secondCopy: boolean;      // SECOND_COPY exists
}

export type PhoneOutcome =
  | { readonly ok: true; readonly serial: string; readonly lines: readonly string[] }
  | { readonly ok: false; readonly why: string };

export const USB_TIP = 'When you\'re done for today, switch USB debugging off: Settings → Developer options → USB debugging.';

const NO_KEY = 'No release key is pinned yet (Task 7, Step 0). Nothing was installed.';
const NOT_RELEASE = 'This APK is not a release build. Only release builds go onto a phone.';
const NOT_OURS = 'This APK is not Daily Commit. Nothing was installed.';
const NOT_SIGNED = 'This APK is not signed with the release key. Nothing was installed: Android would refuse it over the installed app, and the only way past that loses the record.';
const NO_SECOND = 'The release key has no second copy yet (R-2). Nothing goes onto the phone until it has one.';
const UNREADABLE = 'This APK could not be read. Nothing was installed.';
const OTHER_EMULATOR = 'emulator-5554 is another project\'s emulator. Nothing was installed.';

/** One device per line of `adb devices`: a serial and its state. The heading line is not a device. */
export function devicesOf(adbDevices: string): { readonly serial: string; readonly state: string }[] {
  const out: { readonly serial: string; readonly state: string }[] = [];
  for (const raw of adbDevices.split(/\r?\n/)) {
    const m = /^(\S+)\s+(\S+)$/.exec(raw.trim());
    const serial = m?.[1];
    const state = m?.[2];
    if (serial === undefined || state === undefined) continue;
    out.push({ serial, state });
  }
  return out;
}

/** The installed app's version code, from `dumpsys package`. Absent when the app is not installed. */
export function installedVersionCode(dumpsysPackage: string): number | undefined {
  const m = /versionCode=(\d+)/.exec(dumpsysPackage);
  return m?.[1] === undefined ? undefined : Number(m[1]);
}

/** What to say when `adb install` refuses. An uninstall is never the suggested fix. */
export function installFailure(out: string): string {
  if (out.includes('INSTALL_FAILED_UPDATE_INCOMPATIBLE')) {
    return 'This install is signed with a different key from the app already on the phone. Do not uninstall Daily Commit: that deletes the record. Rebuild with the release key.';
  }
  if (out.includes('INSTALL_FAILED_VERSION_DOWNGRADE')) {
    return 'This APK is an older version than the one already on the phone.';
  }
  if (out.includes('INSTALL_FAILED_INSUFFICIENT_STORAGE')) {
    return 'The phone does not have enough free space for this update.';
  }
  if (/INSTALL_FAILED_VERIFICATION_FAILURE|INSTALL_FAILED_ABORTED|INSTALL_FAILED_USER_RESTRICTED|CANCELED_BY_USER/.test(out)) {
    return 'The phone blocked or cancelled the install. Unlock it, watch for a Play Protect prompt, allow it, and run this again.';
  }
  return 'The install did not succeed. The adb output is above.';
}

function chooseSerial(listed: readonly { readonly serial: string; readonly state: string }[], asked: string | undefined): PhoneOutcome | { readonly ok: true; readonly serial: string } {
  if (asked === 'emulator-5554') return { ok: false, why: OTHER_EMULATOR };
  const attached = listed.filter(d => d.state === 'device' && d.serial !== 'emulator-5554');
  if (asked !== undefined) {
    return attached.some(d => d.serial === asked)
      ? { ok: true, serial: asked }
      : { ok: false, why: `No device named ${asked} is attached. Nothing was installed.` };
  }
  const phones = attached.filter(d => !d.serial.startsWith('emulator-'));
  if (phones.length === 1 && phones[0] !== undefined) return { ok: true, serial: phones[0].serial };
  const names = (phones.length === 0 ? attached : phones).map(d => d.serial);
  return { ok: false, why: `Say which device with --serial: ${names.join(', ')}` };
}

function succeeded(out: string): boolean {
  return out.split(/\r?\n/).some(line => line.trim() === 'Success');
}

/**
 * The install, in order. The first failure is the result, and nothing after it is called.
 * `phone.ts` itself never uninstalls and never passes -d.
 */
export function installOnPhone(exec: Exec, o: PhoneOptions): PhoneOutcome {
  if (o.pinnedCert === '') return { ok: false, why: NO_KEY };

  const debug = exec('apkanalyzer', ['manifest', 'debuggable', o.apk]);
  if (debug.code !== 0) return { ok: false, why: UNREADABLE };
  if (debug.out.trim() !== 'false') return { ok: false, why: NOT_RELEASE };

  const id = exec('apkanalyzer', ['manifest', 'application-id', o.apk]);
  if (id.code !== 0) return { ok: false, why: UNREADABLE };
  if (id.out.trim() !== APP_ID) return { ok: false, why: NOT_OURS };

  const certs = exec('apksigner', ['verify', '--print-certs', o.apk]);
  const signers = signersOf(certs.out);
  if (certs.code !== 0 || signers.length !== 1 || signers[0] !== o.pinnedCert) return { ok: false, why: NOT_SIGNED };

  const expected = versionCodeOf(o.version);
  const printed = exec('apkanalyzer', ['manifest', 'version-code', o.apk]);
  const text = printed.out.trim();
  if (printed.code !== 0 || !/^\d+$/.test(text) || Number(text) !== expected) {
    return { ok: false, why: `This APK's version code is ${text || 'missing'}, not ${expected} from ${o.version}. Nothing was installed.` };
  }
  const apkCode = Number(text);

  const devices = exec('adb', ['devices']);
  if (devices.code !== 0) return { ok: false, why: 'No device could be listed. Nothing was installed.' };
  const choice = chooseSerial(devicesOf(devices.out), o.serial);
  if (!choice.ok) return choice;
  const serial = choice.serial;

  if (!serial.startsWith('emulator-') && !o.secondCopy) return { ok: false, why: NO_SECOND };

  const dumped = exec('adb', ['-s', serial, 'shell', 'dumpsys', 'package', APP_ID]);
  if (dumped.code !== 0) return { ok: false, why: 'The version on the phone could not be read. Nothing was installed.' };
  const onPhone = installedVersionCode(dumped.out);
  if (onPhone !== undefined && onPhone > apkCode) {
    return { ok: false, why: `The phone has a newer version (${onPhone}) than this APK (${apkCode}). An older version is never installed over a newer one.` };
  }

  const installed = exec('adb', ['-s', serial, 'install', '-r', o.apk]);
  if (installed.code === 0 && succeeded(installed.out)) {
    const lines = [`Installed on ${serial}, over what was there.`];
    if (!serial.startsWith('emulator-')) lines.push(USB_TIP);
    return { ok: true, serial, lines };
  }
  return { ok: false, why: installFailure(installed.out) };
}

/** adb as an argument list; apkanalyzer and apksigner as one quoted command, the same way the APK check runs them. */
export function phoneExec(): Exec {
  const tc = toolchain(process.env);
  const env = childEnv(tc, process.env);
  const paths = toolPaths(tc);
  return (tool, args) => {
    if (tool === 'adb') {
      const r = spawnSync(paths.adb, args, { encoding: 'utf8', env, windowsHide: true, timeout: 300_000, maxBuffer: 64 * 1024 * 1024 });
      return { code: r.status ?? 1, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
    }
    const bat = tool === 'apkanalyzer' ? paths.apkanalyzer : paths.apksigner;
    const apk = args[args.length - 1] ?? '';
    const head = args.slice(0, -1).join(' ');
    const r = spawnSync(`"${bat}" ${head} "${apk}"`, { shell: true, encoding: 'utf8', env, windowsHide: true, timeout: 300_000, maxBuffer: 64 * 1024 * 1024 });
    return { code: r.status ?? 1, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
  };
}

function packageVersion(): string {
  const parsed = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version?: unknown };
  if (typeof parsed.version !== 'string') throw new Error('package.json has no version');
  return parsed.version;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const serial = args[1];
  const parsed = args.length === 0
    ? { ok: true as const, serial: undefined }
    : args.length === 2 && args[0] === '--serial' && serial !== undefined && serial !== ''
      ? { ok: true as const, serial }
      : { ok: false as const };
  if (!parsed.ok) {
    console.log('usage: node scripts/android/phone.ts [--serial <serial>]');
    process.exitCode = 2;
  } else {
    const out = installOnPhone(phoneExec(), {
      apk: SIGNED_APK,
      serial: parsed.serial,
      version: packageVersion(),
      pinnedCert: RELEASE_CERT_SHA256,
      secondCopy: existsSync(SECOND_COPY),
    });
    if (out.ok) {
      for (const line of out.lines) console.log(line);
      process.exitCode = 0;
    } else {
      console.log(out.why);
      process.exitCode = 1;
    }
  }
}
