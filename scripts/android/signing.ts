// The release key's certificate pin, the version-code rule, and the properties text that points at
// the key. The key itself stays outside the repo. A password is never printed.
// node scripts/android/signing.ts new-key --dir <folder>
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { childEnv, toolchain, toolPaths } from './env.ts';
import { runSync } from './proc.ts';

/** The release key's certificate, SHA-256, lowercase hex, as apksigner prints it. Empty until Step 0; then pinned for good. */
export const RELEASE_CERT_SHA256: string = 'b92b6b89d794155d518ff56e4f6260709124bd7f89bc299c5d20bb4e5c49441f';
export const KEY_ALIAS = 'daily-commit';
export const KEY_FILE = 'daily-commit.jks';
export const PROPS_FILE = 'keystore.properties';
export const LOCAL_PROPS = 'android/local.properties';
/** The line in android/local.properties that names the signing properties file. */
export const SIGNING_LINE = 'dailycommit.signing';
export const SECOND_COPY = '.local/android/second-copy.txt';

/** major * 10000 + minor * 100 + patch; minor and patch stay under 100. */
export function versionCodeOf(version: string): number {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  const majorText = m?.[1];
  const minorText = m?.[2];
  const patchText = m?.[3];
  if (majorText === undefined || minorText === undefined || patchText === undefined) throw new Error(`not a version code: ${version}`);
  const minor = Number(minorText);
  const patch = Number(patchText);
  if (minor >= 100 || patch >= 100) throw new Error(`not a version code: ${version}`);
  return Number(majorText) * 10000 + minor * 100 + patch;
}

/** Each signer's certificate SHA-256 in `apksigner verify --print-certs` output. */
export function signersOf(printCerts: string): string[] {
  const out: string[] = [];
  for (const m of printCerts.matchAll(/^Signer #\d+ certificate SHA-256 digest: ([0-9a-f]{64})\s*$/gm)) {
    const hex = m[1];
    if (hex !== undefined) out.push(hex);
  }
  return out;
}

/** The SHA256 line of `keytool -list -v`, as apksigner writes it (no colons, lowercase). */
export function keytoolSha256(listing: string): string | undefined {
  const m = /SHA256:\s*((?:[0-9A-F]{2}:){31}[0-9A-F]{2})/.exec(listing);
  return m?.[1]?.split(':').join('').toLowerCase();
}

/** keystore.properties for a key file and its password: forward slashes, one password (PKCS12). */
export function propertiesText(keyFile: string, password: string): string {
  const storeFile = keyFile.split('\\').join('/');
  return `storeFile=${storeFile}\nstorePassword=${password}\nkeyPassword=${password}\nkeyAlias=${KEY_ALIAS}\n`;
}

/** The property name, with a dot that stays a dot inside a regular expression. */
function signingLinePattern(rest: string): RegExp {
  const name = SIGNING_LINE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^${name}=${rest}`, 'm');
}

/** The signing properties path android/local.properties names, if any. */
export function signingPathOf(localProps: string): string | undefined {
  const m = signingLinePattern('([^\\n\\r]*)').exec(localProps);
  const value = m?.[1]?.trim() ?? '';
  return value === '' ? undefined : value;
}

/** android/local.properties with the signing line set; every other line kept. */
export function withSigningLine(localProps: string, path: string): string {
  const line = `${SIGNING_LINE}=${path.split('\\').join('/')}`;
  const re = signingLinePattern('[^\\n]*');
  if (re.test(localProps)) return localProps.replace(re, line);
  const trimmed = localProps.replace(/\s*$/, '');
  return trimmed === '' ? `${line}\n` : `${trimmed}\n${line}\n`;
}

/** Makes the release key in `dir` and points the ignored local file at its properties. Refuses if the key file is already there. */
function newKey(dir: string): number {
  const keyPath = join(dir, KEY_FILE);
  if (existsSync(keyPath)) {
    console.log('a release key is already there; nothing was made');
    return 1;
  }
  mkdirSync(dir, { recursive: true });
  const password = randomBytes(24).toString('base64url');
  const tmp = join(dir, `pass-${randomBytes(6).toString('hex')}.tmp`);
  const tc = toolchain(process.env);
  const env = childEnv(tc, process.env);
  const keytool = toolPaths(tc).keytool;
  const base = ['-keystore', keyPath, '-storepass:file', tmp];
  try {
    writeFileSync(tmp, password, { mode: 0o600 });
    const made = runSync(keytool, ['-genkeypair', ...base, '-storetype', 'PKCS12', '-alias', KEY_ALIAS, '-keyalg', 'RSA',
      '-keysize', '4096', '-validity', '10000', '-dname', 'CN=Daily Commit', '-keypass:file', tmp],
      { encoding: 'utf8', env, windowsHide: true, timeout: 300_000 });
    if ((made.status ?? 1) !== 0) {
      if (existsSync(keyPath)) unlinkSync(keyPath);
      console.log('the key could not be made');
      return 1;
    }
    const listed = runSync(keytool, ['-list', '-v', ...base], { encoding: 'utf8', env, windowsHide: true, timeout: 120_000 });
    const sha = keytoolSha256(`${listed.stdout ?? ''}\n${listed.stderr ?? ''}`);
    if ((listed.status ?? 1) !== 0 || sha === undefined) {
      if (existsSync(keyPath)) unlinkSync(keyPath);
      console.log('the certificate could not be read; the key file was removed');
      return 1;
    }
    writeFileSync(join(dir, PROPS_FILE), propertiesText(keyPath, password), { mode: 0o600 });
    const existing = existsSync(LOCAL_PROPS) ? readFileSync(LOCAL_PROPS, 'utf8') : '';
    writeFileSync(LOCAL_PROPS, withSigningLine(existing, join(dir, PROPS_FILE)));
    console.log(`key made · certificate SHA-256 ${sha} · copy the whole folder to a second place today`);
    return 0;
  } finally {
    if (existsSync(tmp)) unlinkSync(tmp);
  }
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const dir = args[2];
  if (args.length === 3 && args[0] === 'new-key' && args[1] === '--dir' && dir !== undefined && dir !== '') {
    process.exitCode = newKey(dir);
  } else {
    console.log('usage: node scripts/android/signing.ts new-key --dir <folder>');
    process.exitCode = 2;
  }
}
