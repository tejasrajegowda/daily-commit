// Checks the Android release APK after the build: the permanent identity (a new app id, scheme or
// hostname would be a new origin, and the stored record lives under the old one), no debuggable
// build, no web debugging or logging, web assets that pass the release check and are exactly what
// was synced, and the leak paths: backup rules, permissions, what other apps can reach, the web view.
// Run by `npm run android:build`, or on its own with `npm run android:check`.
// node scripts/android/apk-check.ts → one line per problem, exit 1 if there is any.
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join, relative, sep } from 'node:path';
import { releaseProblems } from '../release-check.ts';
import { childEnv, toolchain, toolPaths } from './env.ts';

export const APP_ID = 'app.dailycommit';
export const UNSIGNED_APK = 'android/app/build/outputs/apk/release/app-release-unsigned.apk';
const PUBLIC_DIR = 'android/app/src/main/assets/public';
const TEXT = new Set(['.html', '.js', '.mjs', '.css', '.json', '.txt', '.svg', '.map']);

export interface ApkView {
  readonly manifest: string;                          // apkanalyzer manifest print
  readonly config: string;                            // assets/capacitor.config.json from the APK
  readonly publicFiles: ReadonlyMap<string, string>;  // android/app/src/main/assets/public/**, text files' text
  readonly apkPublicList: readonly string[];          // the APK's entries under assets/public/, relative
  readonly resources?: ReadonlyMap<string, string>;   // Task 2a: res/xml/…, res/layout/… as decoded XML
}

/** The app has no internet: its pages load from https://localhost through Capacitor's own request handling,
 *  proven on the emulator without the permission, so a build that asks for it is refused. */
export const INTERNET_ALLOWED = false;
export const RULES_PATH = 'res/xml/data_extraction_rules.xml';
export const LAYOUT_PATH = 'res/layout/capacitor_bridge_layout_main.xml';
const ALLOWED_PERMISSIONS = new Set([
  'android.permission.POST_NOTIFICATIONS',
  'android.permission.USE_EXACT_ALARM',
  'android.permission.RECEIVE_BOOT_COMPLETED',   // the notification plugin's: reminders after a restart
  'android.permission.WAKE_LOCK',
  'app.dailycommit.DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION',   // AndroidX's own
  ...(INTERNET_ALLOWED ? ['android.permission.INTERNET'] : []),
]);
const OPEN_TO_OTHER_APPS = new Set(['app.dailycommit.MainActivity', '.MainActivity']);
const SNAPSHOT = { domain: 'file', path: 'backup/latest.dcbak' };
const BACKUP_DOMAINS = ['root', 'file', 'database', 'sharedpref', 'external', 'device_root', 'device_file', 'device_database', 'device_sharedpref'];
const NO_EXCLUDE_DESCENDANTS = new Set(['noExcludeDescendants', '8', '0x8']);   // a decoded binary layout prints the number

export function apkProblems(apk: ApkView): string[] {
  return [...manifestProblems(apk.manifest), ...configProblems(apk.config), ...assetProblems(apk), ...(apk.resources ? leakProblems(apk) : [])];
}

interface Tag { readonly name: string; readonly attrs: string; readonly body: string }

/** The opening tags in a piece of XML, as printed by apkanalyzer or written in source (attributes may span lines). */
function tags(xml: string): Tag[] {
  return [...xml.matchAll(/<([A-Za-z][\w.:-]*)\b([^>]*)>/g)].map(m => ({ name: m[1] ?? '', attrs: (m[2] ?? '').replace(/\/$/, ''), body: '' }));
}

/** Every <name …>…</name> (or <name …/>) element, with what it holds. */
function elements(xml: string, name: string): Tag[] {
  return [...xml.matchAll(new RegExp(`<${name}\\b([^>]*?)(?:/>|>([\\s\\S]*?)</${name}>)`, 'g'))].map(m => ({ name, attrs: m[1] ?? '', body: m[2] ?? '' }));
}

function attr(attrs: string, name: string): string | undefined {
  return new RegExp(`\\s${name}="([^"]*)"`).exec(attrs)?.[1];
}

/** Backup, permissions, what other apps can reach, and the web view: the ways the record could leave the app. */
export function leakProblems(apk: ApkView): string[] {
  return [...leakManifestProblems(apk.manifest), ...rulesProblems(apk.resources?.get(RULES_PATH)), ...layoutProblems(apk.resources?.get(LAYOUT_PATH))];
}

function leakManifestProblems(manifest: string): string[] {
  const problems: string[] = [];
  const app = tags(manifest).find(t => t.name === 'application');
  if (!app) return ['manifest: no application element'];
  if (attr(app.attrs, 'android:allowBackup') !== 'true') problems.push('manifest: allowBackup is not true (the locked snapshot would not be backed up)');
  if (attr(app.attrs, 'android:dataExtractionRules') === undefined) problems.push('manifest: no dataExtractionRules (a backup would carry everything)');
  if (/android:fullBackupContent=/.test(manifest)) problems.push('manifest: fullBackupContent is set (rules for Android 11 and older)');
  if (/android:usesCleartextTraffic="true"/.test(manifest)) problems.push('manifest: cleartext traffic is allowed');
  const permissions = tags(manifest).filter(t => t.name === 'uses-permission' || t.name === 'uses-permission-sdk-23').map(t => attr(t.attrs, 'android:name') ?? '?');
  for (const p of permissions) {
    if (p === 'android.permission.SCHEDULE_EXACT_ALARM') problems.push('manifest: SCHEDULE_EXACT_ALARM is requested (the plugin would open the alarms screen)');
    else if (!ALLOWED_PERMISSIONS.has(p)) problems.push(`manifest: permission ${p} is not allowed`);
  }
  for (const p of ['android.permission.USE_EXACT_ALARM', 'android.permission.POST_NOTIFICATIONS']) {
    if (!permissions.includes(p)) problems.push(`manifest: ${p} is missing`);
  }
  if (/androidx\.core\.content\.FileProvider/.test(manifest)) problems.push('manifest: a file provider is declared');
  for (const t of tags(manifest).filter(t => ['activity', 'activity-alias', 'service', 'receiver', 'provider'].includes(t.name))) {
    if (attr(t.attrs, 'android:exported') !== 'true') continue;
    const name = attr(t.attrs, 'android:name') ?? '?';
    if (OPEN_TO_OTHER_APPS.has(name) || attr(t.attrs, 'android:permission') === 'android.permission.DUMP') continue;
    problems.push(`manifest: ${t.name} ${name} is open to other apps`);
  }
  return problems;
}

/** The include-only rule for one backup mode: exactly the locked snapshot, nothing else. */
function onlySnapshot(section: string, found: Tag[]): string[] {
  if (found.length !== 1) return [`backup rules: ${found.length} <${section}> section(s), not 1 (a missing section backs up everything)`];
  const children = tags(found[0]?.body ?? '');
  const ok = children.length === 1 && children[0]?.name === 'include'
    && attr(children[0].attrs, 'domain') === SNAPSHOT.domain && attr(children[0].attrs, 'path') === SNAPSHOT.path;
  return ok ? [] : [`backup rules: <${section}> must hold only <include domain="file" path="backup/latest.dcbak">`];
}

function rulesProblems(xml: string | undefined): string[] {
  if (xml === undefined) return [`backup rules: ${RULES_PATH} is missing`];
  const problems: string[] = [];
  const cloud = elements(xml, 'cloud-backup');
  problems.push(...onlySnapshot('cloud-backup', cloud));
  if (cloud.length === 1 && attr(cloud[0]?.attrs ?? '', 'disableIfNoEncryptionCapabilities') !== 'true') {
    problems.push('backup rules: cloud backup is not limited to a phone that encrypts it');
  }
  problems.push(...onlySnapshot('device-transfer', elements(xml, 'device-transfer')));
  const cross = elements(xml, 'cross-platform-transfer').filter(t => attr(t.attrs, 'platform') === 'ios');
  const excluded = tags(cross[0]?.body ?? '');
  const complete = cross.length === 1 && excluded.length === BACKUP_DOMAINS.length
    && excluded.every(t => t.name === 'exclude' && attr(t.attrs, 'path') === '.')
    && BACKUP_DOMAINS.every(d => excluded.some(t => attr(t.attrs, 'domain') === d));
  if (!complete) problems.push('backup rules: <cross-platform-transfer platform="ios"> must exclude each of the nine domains, and nothing else');
  return problems;
}

function layoutProblems(xml: string | undefined): string[] {
  if (xml === undefined) return [`web view: ${LAYOUT_PATH} is missing`];
  const views = tags(xml).filter(t => /WebView$/.test(t.name));
  if (views.length !== 1 || views[0]?.name !== 'app.dailycommit.PrivateWebView') return ['web view: the layout\'s web view is not app.dailycommit.PrivateWebView'];
  const view = views[0];
  return ['importantForAutofill', 'importantForContentCapture']
    .filter(a => !NO_EXCLUDE_DESCENDANTS.has(attr(view.attrs, `android:${a}`) ?? ''))
    .map(a => `web view: ${a} is not noExcludeDescendants`);
}

function manifestProblems(manifest: string): string[] {
  const problems: string[] = [];
  const pkg = /<manifest\b[^>]*\spackage="([^"]*)"/.exec(manifest);
  if (pkg?.[1] !== APP_ID) problems.push(`manifest: package is ${pkg?.[1] ?? 'missing'}, not ${APP_ID}`);
  if (/android:debuggable="true"/.test(manifest)) problems.push('manifest: the build is debuggable');
  return problems;
}

function configProblems(text: string): string[] {
  let c: Record<string, unknown>;
  try {
    c = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return ['config: capacitor.config.json is not readable JSON'];
  }
  const problems: string[] = [];
  const server = (c.server ?? {}) as Record<string, unknown>;
  const android = (c.android ?? {}) as Record<string, unknown>;
  if (c.appId !== APP_ID) problems.push(`config: appId is not ${APP_ID}`);
  if (server.androidScheme !== 'https') problems.push('config: server.androidScheme is not https');
  if (server.hostname !== 'localhost') problems.push('config: server.hostname is not localhost');
  if (server.url !== undefined) problems.push('config: a server url is set');
  if (server.cleartext === true) problems.push('config: cleartext is allowed');
  if (android.webContentsDebuggingEnabled !== false) problems.push('config: android.webContentsDebuggingEnabled is not false');
  const logging = [c.loggingBehavior, android.loggingBehavior].filter(v => v !== undefined);
  if (logging.length === 0) problems.push('config: no loggingBehavior is set');
  if (logging.some(v => v !== 'none')) problems.push('config: loggingBehavior is not none');
  if (android.allowMixedContent === true) problems.push('config: mixed content is allowed');
  return problems;
}

function assetProblems(apk: ApkView): string[] {
  const problems = releaseProblems(apk.publicFiles).map(p => `assets/public/${p}`);
  const synced = [...apk.publicFiles.keys()].sort();
  const packed = [...apk.apkPublicList].sort();
  if (synced.join('\n') !== packed.join('\n')) problems.push(`assets/public: the APK carries ${packed.length} file(s), ${synced.length} were synced`);
  return problems;
}

function readPublic(dir: string): Map<string, string> {
  const files = new Map<string, string>();
  const walk = (at: string) => {
    for (const name of readdirSync(at)) {
      const p = join(at, name);
      if (statSync(p).isDirectory()) walk(p);
      else files.set(relative(dir, p).split(sep).join('/'), TEXT.has(extname(name)) ? readFileSync(p, 'utf8') : '');
    }
  };
  walk(dir);
  return files;
}

/**
 * One resource as decoded XML, read from the APK. A release build shortens resource paths (res/xml/x.xml
 * becomes res/8K.xml), so the short path is found through the resource table by type and name.
 */
function readResource(path: string, env: Record<string, string>, tool: string): string | undefined {
  const m = /^res\/([a-z]+)\/([\w]+)\.xml$/.exec(path);
  if (!m) return undefined;
  try {
    const packed = apkanalyzer(`resources value --config default --name ${m[2]} --type ${m[1]}`, env, tool).trim();
    return /^res\/[\w./-]+$/.test(packed) ? apkanalyzer(`resources xml --file ${packed}`, env, tool) : undefined;
  } catch {
    return undefined;   // reported as missing
  }
}

/** One apkanalyzer command; a .bat can't be spawned without a shell, so the command is one fixed string. */
function apkanalyzer(args: string, env: Record<string, string>, tool: string): string {
  const r = spawnSync(`"${tool}" ${args} "${UNSIGNED_APK}"`, { shell: true, encoding: 'utf8', env, windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`apkanalyzer ${args.split(' ')[0] ?? ''} failed (exit ${r.status ?? 'none'})`);
  return r.stdout;
}

if (import.meta.main) {
  const tc = toolchain(process.env);
  const env = childEnv(tc, process.env);
  const tool = toolPaths(tc).apkanalyzer;
  const prefix = '/assets/public/';
  const apkPublicList = apkanalyzer('files list', env, tool).split(/\r?\n/).map(l => l.trim())
    .filter(l => l.startsWith(prefix) && !l.endsWith('/')).map(l => l.slice(prefix.length));
  const problems = apkProblems({
    manifest: apkanalyzer('manifest print', env, tool),
    config: apkanalyzer('files cat --file /assets/capacitor.config.json', env, tool),
    publicFiles: readPublic(PUBLIC_DIR),
    apkPublicList,
    resources: new Map([RULES_PATH, LAYOUT_PATH].flatMap(p => { const xml = readResource(p, env, tool); return xml === undefined ? [] : [[p, xml] as const]; })),
  });
  for (const p of problems) console.log(p);
  console.log(problems.length ? `apk check: ${problems.length} problem(s)` : 'apk check: clean');
  process.exitCode = problems.length ? 1 : 0;
}
