// Task 8b. Android's backup on the test phone, read by the files it stored, then a wiped
// install and the two ways back in. adb stays on emulator-5556.
import { spawnSync } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { adbOnTestPhone, find, pause, TEST_SERIAL, type Emu, type UiNode } from '../drive.ts';
import { childEnv, toolchain, toolPaths } from '../env.ts';
import {
  appInFront, dismissKeyguard, focusSecret, guardUninstall, launch, locked, openFoundCopy,
  pastLock, pushSeed, restoreSeed, showing, unlock, type Check, type RunCtx,
} from './a.ts';
import { canaryHits, type Hit } from './canary.ts';
import { ourNotifications } from './dumps.ts';
import type { Seed } from './seed.ts';
import { tarEntries, type TarEntry } from './tar.ts';

const APP = 'app.dailycommit';
const LOCAL = 'com.android.localtransport/.LocalTransport';
const STABLE_BACKUP = join('.local', 'android', '8b-backup.tar');
const TRANSPORT_FILE = join('.local', 'android', '8b-transport.json');
const DATA_TAR_REMOTE = '/data/local/tmp/dc-8b-data.tar';

const CANARY_KEYS = ['diary', 'notYet', 'intent', 'remark', 'privateCue', 'shownCue'] as const;
type CanaryKey = typeof CANARY_KEYS[number];

export interface TransportNote {
  noted: string;
  enabled: boolean;
  applied: boolean;
  putBack: boolean;
}

export interface BCtx extends RunCtx {
  transport: TransportNote;
  /** Files saved for B4, relative to dir. The backup itself is backup.tar. */
  backupSaved: string[];
  prepareSeed(phone: Emu): Promise<void>;
}

export function emptyTransport(): TransportNote {
  return { noted: '', enabled: true, applied: false, putBack: false };
}

function rx(label: string, whole: boolean): RegExp {
  const body = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(whole ? `^${body}$` : body, 'i');
}
const words = (label: string) => rx(label, true);
const has = (label: string) => rx(label, false);

function oneLine(out: string): string {
  return out.replace(/\s+/g, ' ').trim().slice(0, 200) || 'no output';
}

function brief(phone: Emu): string {
  return phone.dump().map(n => (n.text || n.desc).replace(/\s+/g, ' ').trim()).filter(t => t.length > 0 && t.length < 60).slice(0, 8).join(' | ') || 'no words';
}

function deviceSec(phone: Emu): number {
  const sec = Number(phone.shell('date +%s').out.trim());
  if (!Number.isFinite(sec) || sec <= 0) throw new Error('the phone clock could not be read');
  return sec;
}

/** `adb root` restarts adbd, and that drop is not a refusal. A production image is. */
export function rootStep(idOut: string, rootOut: string): 'root' | 'retry' | 'refused' {
  if (idOut.includes('uid=0') || /already running as root/i.test(rootOut)) return 'root';
  if (/cannot run as root|production builds/i.test(`${idOut}\n${rootOut}`)) return 'refused';
  return 'retry';
}

function asRoot(): void {
  let last = '';
  for (let attempt = 0; attempt < 3; attempt++) {
    const id = adbOnTestPhone(['shell', 'id'], 20_000);
    if (rootStep(id.out, '') === 'root') return;
    const root = adbOnTestPhone(['root'], 60_000);
    last = root.out;
    const step = rootStep(id.out, root.out);
    if (step === 'refused') throw new Error(`adb root was refused (${oneLine(root.out)})`);
    if (step === 'root') return;
    try {
      adbOnTestPhone(['wait-for-device'], 60_000);
    } catch {
      // The next id is the check. The phone may still be restarting adbd.
    }
    pause(1_000);
  }
  const id = adbOnTestPhone(['shell', 'id'], 20_000);
  if (id.out.includes('uid=0')) return;
  throw new Error(`adb root was refused (${oneLine(id.out || last)})`);
}

function wake(phone: Emu): void {
  phone.key('KEYCODE_WAKEUP');
  pause(500);
  dismissKeyguard(phone);
}

/** The component marked with `*` in `bmgr list transports`. */
export function markedTransport(out: string): string | undefined {
  for (const line of out.split(/\r?\n/)) {
    const marked = /^\s*\*\s*(\S+)/.exec(line)?.[1];
    if (marked) return marked;
  }
  return undefined;
}

/** `Backup Manager currently enabled` / `disabled`. */
export function backupEnabled(out: string): boolean | undefined {
  if (/currently enabled/i.test(out)) return true;
  if (/currently disabled/i.test(out)) return false;
  return undefined;
}

/** True when this package's backupnow result is Success and no line reports a failure for it. */
export function backupNowOk(out: string): boolean {
  const lines = out.split(/\r?\n/).map(l => l.trim()).filter(l => l !== '');
  const pkg = lines.filter(l => l.includes(APP));
  if (pkg.some(l => /error|fail|reject|unknown/i.test(l) && !/result:\s*Success\b/.test(l))) return false;
  if (pkg.some(l => /result:\s*Success\b/.test(l))) return true;
  return /Backup finished with result:\s*Success\b/.test(out) && !pkg.some(l => /result:/.test(l));
}

function componentName(name: string): string {
  if (!/^[\w./$]+$/.test(name)) throw new Error('the transport name was not a component name');
  return name;
}

export function loadTransport(): TransportNote {
  try {
    const parsed = JSON.parse(readFileSync(TRANSPORT_FILE, 'utf8')) as Partial<TransportNote>;
    if (typeof parsed.noted !== 'string' || typeof parsed.enabled !== 'boolean') return emptyTransport();
    return {
      noted: parsed.noted,
      enabled: parsed.enabled,
      applied: parsed.applied === true,
      putBack: parsed.putBack === true,
    };
  } catch {
    return emptyTransport();
  }
}

function saveTransport(note: TransportNote): void {
  mkdirSync(join('.local', 'android'), { recursive: true });
  writeFileSync(TRANSPORT_FILE, `${JSON.stringify(note)}\n`);
}

/** The local transport, encrypted, without forgetting which transport was in use. */
export function useLocalTransport(phone: Emu, note: TransportNote): void {
  if (note.noted === '') {
    const enabled = backupEnabled(phone.shell('bmgr enabled').out);
    const noted = markedTransport(phone.shell('bmgr list transports').out);
    if (enabled === undefined || noted === undefined) throw new Error('the current backup transport could not be read');
    note.enabled = enabled;
    note.noted = componentName(noted);
    saveTransport(note);
  }
  phone.shell('bmgr enable true');
  const selected = phone.shell(`bmgr transport ${LOCAL}`);
  if (selected.code !== 0 || !selected.out.includes(LOCAL)) throw new Error(`the local transport was not selected (${oneLine(selected.out)})`);
  const enc = phone.shell("settings put secure backup_local_transport_parameters 'is_encrypted=true'");
  if (enc.code !== 0) throw new Error(`backup encryption was not set (${oneLine(enc.out)})`);
  note.applied = true;
  note.putBack = false;
  saveTransport(note);
}

/** B8. Puts the noted transport back. Returns an error string, or nothing when it matches. */
export function putTransportBack(phone: Emu, note: TransportNote): string | undefined {
  if (note.noted === '' || !note.applied) return undefined;
  const name = componentName(note.noted);
  const selected = phone.shell(`bmgr transport ${name}`);
  phone.shell('settings delete secure backup_local_transport_parameters');
  phone.shell(`bmgr enable ${note.enabled ? 'true' : 'false'}`);
  const now = markedTransport(phone.shell('bmgr list transports').out);
  note.putBack = now === name;
  saveTransport(note);
  if (now !== name) return `transport is ${now ?? 'unmarked'} (${oneLine(selected.out)})`;
  return undefined;
}

function relOf(path: string): string {
  return path.replace(/^\/data\/(?:data|user\/0|user_de\/0)\/app\.dailycommit\//, '');
}

function pathLines(out: string): string[] {
  return [...new Set(out.split(/\r?\n/).map(l => l.trim()).filter(l => l.startsWith('/data/')))];
}

function appFiles(phone: Emu): string[] {
  asRoot();
  const listed = phone.shell(`find /data/data/${APP} /data/user_de/0/${APP} -type f 2>/dev/null`);
  return pathLines(listed.out);
}

/** Names apart from `_manifest` are exactly `backup/latest.dcbak`, and none of the excluded domains. */
export function snapshotNames(names: readonly string[]): string | undefined {
  const leak = names.filter(n => /(?:^|\/)(?:no_backup|shared_prefs|app_webview|databases)\//.test(n));
  if (leak.length > 0) return `backup names include ${leak.slice(0, 4).join(', ')}`;
  const manifests = names.filter(n => n.endsWith('/_manifest') || n.endsWith('_manifest'));
  const rest = names.filter(n => !manifests.includes(n));
  if (manifests.length !== 1 || rest.length !== 1) return `names ${names.join(', ') || 'none'}`;
  if (!rest[0]?.endsWith('backup/latest.dcbak')) return `the file was ${rest[0]}`;
  return undefined;
}

function captureTo(args: readonly string[], dest: string, timeoutMs: number): number {
  const tc = toolchain(process.env);
  const fd = openSync(dest, 'w');
  try {
    const ran = spawnSync(toolPaths(tc).adb, ['-s', TEST_SERIAL, ...args], {
      env: childEnv(tc, process.env), windowsHide: true, timeout: timeoutMs, stdio: ['ignore', fd, 'ignore'],
    });
    return ran.status ?? 1;
  } finally {
    closeSync(fd);
  }
}

function looksLikeTar(path: string): boolean {
  let fd: number | undefined;
  try {
    fd = openSync(path, 'r');
    const buf = Buffer.alloc(262);
    const n = readSync(fd, buf, 0, 262, 0);
    return n >= 262 && buf.subarray(257, 262).toString('utf8') === 'ustar';
  } catch {
    return false;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function removeDataTar(phone: Emu): void {
  try {
    asRoot();
    phone.shell(`rm -f ${DATA_TAR_REMOTE}`);
  } catch {
    // The phone may already be gone.
  }
}

function showsWalk(nodes: readonly UiNode[]): boolean {
  return find(nodes, words('Walk')) !== undefined && pastLock(nodes);
}

function allowReminders(phone: Emu, ctx: BCtx): void {
  ctx.note('the reminder ask was up');
  phone.tap(words('Continue'), 15_000);
  const allow = /^\s*allow\s*$/i;
  if (phone.waitFor(allow, 8_000)) phone.tap(allow, 8_000);
  if (phone.waitFor(words('Done'), 15_000)) phone.tap(words('Done'), 10_000);
  if (showing(phone, words('Today'))) phone.tap(words('Today'), 10_000);
}

function seeWalk(phone: Emu, ctx: BCtx): void {
  if (phone.waitFor(words('Walk'), 25_000) && showsWalk(phone.dump())) return;
  if (showing(phone, has('Let Daily Commit send reminders'))) {
    allowReminders(phone, ctx);
    if (phone.waitFor(words('Walk'), 20_000) && showsWalk(phone.dump())) return;
  }
  ctx.save('today.xml', phone.lastXml());
  throw new Error(`Today did not show Walk (${brief(phone)})`);
}

/**
 * The passphrase-only lock. This WebView does not put the field's placeholder in the tree, so the
 * proof is Locked, Open, the phone hint, and a password field, with no device way beside them.
 * "Use the recovery code instead" belongs to this lock. "Use your passphrase" means another way is primary.
 */
export function passphraseOnlyScreen(nodes: readonly UiNode[]): string | undefined {
  if (find(nodes, has('Unlock with fingerprint')) || find(nodes, has("Use your phone's PIN")) || find(nodes, words('Use your code')) || find(nodes, words('Use your passphrase'))) {
    return 'the lock screen offered another way';
  }
  const locked = find(nodes, words('Locked')) !== undefined;
  const open = find(nodes, words('Open')) !== undefined;
  const labelled = find(nodes, words('Passphrase')) !== undefined;
  const hint = find(nodes, has('Your passphrase')) !== undefined;
  const field = nodes.some(n => n.cls.includes('EditText'));
  if (!locked || !open || (!hint && !labelled) || !field) return 'the passphrase lock was not up';
  return undefined;
}

/** The lock screen is the passphrase field, with no device copy offered beside it. */
function onlyPassphrase(phone: Emu): string | undefined {
  const why = passphraseOnlyScreen(phone.dump());
  return why === undefined ? undefined : `${why} (${brief(phone)})`;
}

/**
 * The recovery-code field. This WebView does not put the placeholder "Recovery code" in the tree.
 * The switch is the button becoming "Use the passphrase instead", with an EditText still on screen.
 */
export function recoveryCodeReady(nodes: readonly UiNode[]): boolean {
  return find(nodes, words('Use the passphrase instead')) !== undefined
    && nodes.some(n => n.cls.includes('EditText'));
}

async function b0(phone: Emu, ctx: BCtx): Promise<void> {
  asRoot();
  guardUninstall();
  const installed = ctx.install();
  ctx.save('b0-install.txt', installed);
  if (!/Installed .+ over what was there/.test(installed)) throw new Error(`the release APK did not install (${oneLine(installed)})`);
  const grant = phone.shell(`pm grant ${APP} android.permission.POST_NOTIFICATIONS`);
  if (grant.code !== 0) throw new Error(`notification permission was not granted (${oneLine(grant.out)})`);
  await ctx.prepareSeed(phone);
  pushSeed(ctx, 'dc-seed.dcbak');
  wake(phone);
  launch(phone, true);
  if (!phone.waitFor(has('Restore from a backup instead'), 40_000)) {
    ctx.save('b0-welcome.xml', phone.lastXml());
    throw new Error(`the welcome screen did not offer restore (${brief(phone)})`);
  }
  restoreSeed(phone, ctx, 'dc-seed.dcbak', true);
  seeWalk(phone, ctx);
}

function b1(phone: Emu, ctx: BCtx): void {
  const now = deviceSec(phone);
  const day = now - (now % 86400);
  const target = day + ((ctx.cues.private + 1) % 1440) * 60;
  if (target > now) {
    const wait = target - now + 5;
    if (wait > 20 * 60) throw new Error(`the private cue is ${Math.round(wait / 60)} min away`);
    ctx.note(`B1 waiting ${wait} s`);
    pause(wait * 1000);
  } else ctx.note('B1 the private cue minute has passed');
  const shown = ctx.seed.canaries.shownCue;
  let dump = '';
  let notes: { title: string; text: string }[] = [];
  const stop = Date.now() + 120_000;
  let seenShown = false;
  let seenEmpty = false;
  do {
    dump = phone.shell('dumpsys notification --noredact').out;
    notes = ourNotifications(dump);
    seenShown = notes.some(n => n.text === shown);
    seenEmpty = notes.some(n => n.text === '');
    if (seenShown && seenEmpty) break;
    pause(5_000);
  } while (Date.now() < stop);
  ctx.save('b1-notification.txt', dump);
  ctx.note(`B1 notifications ${notes.length}, shown ${seenShown}, empty ${seenEmpty}`);
  if (!seenShown || !seenEmpty) throw new Error(`notifications ${notes.length}, shown text ${seenShown}, empty text ${seenEmpty}`);
}

function snapshotThere(phone: Emu): boolean {
  asRoot();
  const listed = phone.shell(`ls /data/data/${APP}/files/backup/latest.dcbak /data/user/0/${APP}/files/backup/latest.dcbak 2>/dev/null`);
  return listed.out.includes('latest.dcbak');
}

function b2(phone: Emu, ctx: BCtx): void {
  wake(phone);
  if (!appInFront(phone)) launch(phone, true);
  if (locked(phone) || showing(phone, words('Passphrase'))) unlock(phone, ctx.seed.passphrase);
  phone.key('KEYCODE_HOME');
  const until = Date.now() + 20_000;
  while (!snapshotThere(phone) && Date.now() < until) pause(1_000);
  if (!snapshotThere(phone)) throw new Error('Home did not write backup/latest.dcbak');
  const before = backupEnabled(phone.shell('bmgr enabled').out);
  const noted = markedTransport(phone.shell('bmgr list transports').out);
  if (before === undefined || noted === undefined) throw new Error('the current backup transport could not be read');
  ctx.transport.enabled = before;
  ctx.transport.noted = componentName(noted);
  ctx.transport.applied = false;
  ctx.transport.putBack = false;
  saveTransport(ctx.transport);
  useLocalTransport(phone, ctx.transport);
  const ran = adbOnTestPhone(['shell', `bmgr backupnow ${APP}`], 180_000);
  ctx.save('b2-backupnow.txt', ran.out);
  const interesting = ran.out.split(/\r?\n/).map(l => l.trim()).filter(l => /result:|Backup finished|disabled|error/i.test(l)).slice(0, 6);
  ctx.note(`B2 ${interesting.join(' | ') || oneLine(ran.out)}`);
  if (!backupNowOk(ran.out)) throw new Error(`bmgr did not report success (${interesting.join(' | ') || oneLine(ran.out)})`);
}

function backupPaths(phone: Emu): string[] {
  asRoot();
  const roots = [
    '/data/cache/backup',
    '/data/cache/backup_stage',
    '/data/data/com.android.localtransport',
    '/data/user/0/com.android.localtransport',
    '/data/user_de/0/com.android.localtransport',
    '/data/system/backup',
  ];
  const found: string[] = [];
  for (const root of roots) {
    const listed = phone.shell(`find ${root} -path '*${APP}*' -type f 2>/dev/null`);
    found.push(...pathLines(listed.out));
  }
  return [...new Set(found)];
}

function fileSize(phone: Emu, path: string): number {
  const stat = phone.shell(`stat -c %s '${path}'`);
  const n = Number(stat.out.trim().split(/\s+/)[0]);
  if (Number.isFinite(n) && n >= 0) return n;
  return -1;
}

function chooseBackup(phone: Emu, ctx: BCtx, paths: readonly string[]): { entries: TarEntry[]; saved: string } {
  mkdirSync(ctx.dir, { recursive: true });
  const dest = join(ctx.dir, 'backup.tar');
  let chosen = '';
  let entries: TarEntry[] = [];
  let kept: Buffer | undefined;
  for (const path of paths) {
    const code = captureTo(['exec-out', 'cat', path], dest, 120_000);
    if (code !== 0 || !looksLikeTar(dest)) continue;
    const bytes = readFileSync(dest);
    const parsed = tarEntries(new Uint8Array(bytes));
    const matches = snapshotNames(parsed.map(e => e.name)) === undefined;
    if (kept === undefined || matches) {
      chosen = path;
      entries = parsed;
      kept = Buffer.from(bytes);
    }
    if (matches) break;
  }
  if (kept === undefined) {
    const first = paths[0];
    if (first === undefined) throw new Error('no backup file for the app was found');
    captureTo(['exec-out', 'cat', first], dest, 120_000);
    chosen = first;
    kept = readFileSync(dest);
    if (looksLikeTar(dest)) entries = tarEntries(new Uint8Array(kept));
  } else writeFileSync(dest, kept);
  writeFileSync(STABLE_BACKUP, kept);
  ctx.backupSaved = ['backup.tar'];
  ctx.note(`B3 read ${chosen} (${fileSize(phone, chosen)} bytes, tar ${entries.length > 0})`);
  return { entries, saved: chosen };
}

function b3(phone: Emu, ctx: BCtx): void {
  const paths = backupPaths(phone);
  const sizes = paths.map(p => `${p} ${fileSize(phone, p)}`);
  ctx.save('b3-files.txt', `${sizes.join('\n')}\n`);
  ctx.note(`B3 files ${paths.length}: ${sizes.join(' | ') || 'none'}`);
  if (paths.length === 0) throw new Error('no backup file for the app was found');
  const { entries } = chooseBackup(phone, ctx, paths);
  if (entries.length === 0) {
    // Full paths. A bare `latest.dcbak` is not the snapshot, and a failed name fails the check.
    const why = snapshotNames(paths);
    if (why !== undefined) throw new Error(`the stored backup is not a plain tar (${why})`);
    ctx.note('B3 the stored form is not a plain tar; the file names pass the same rule');
    return;
  }
  const listed = entries.map(e => `${e.name} ${e.size}`).join(' | ');
  ctx.note(`B3 tar ${listed}`);
  const why = snapshotNames(entries.map(e => e.name));
  if (why !== undefined) throw new Error(why);
}

/** An empty capture is a failed read. It is not a search that found nothing. */
export function readSearched(path: string, what: string): Uint8Array {
  if (!existsSync(path)) throw new Error(`${what} was not read`);
  const bytes = new Uint8Array(readFileSync(path));
  if (bytes.byteLength === 0) throw new Error(`${what} was not read`);
  return bytes;
}

function countOf(hits: readonly Hit[], canary: string): number {
  return hits.filter(h => h.canary === canary).length;
}

/**
 * A hit is allowed only for the shown reminder, and only in the notification dump,
 * the app's data, or the notification store. A private reminder, and every other canary, is never allowed.
 */
export function forbiddenCanary(key: string, source: string, hits: number): boolean {
  if (hits === 0) return false;
  return !(key === 'shownCue' && (source === 'notif' || source === 'data' || source === 'xml'));
}

function canaryOf(seed: Seed, key: CanaryKey): string {
  return seed.canaries[key];
}

function captureDataTar(phone: Emu, dest: string): void {
  asRoot();
  const piped = captureTo(['exec-out', 'tar', '-cf', '-', `/data/data/${APP}`, `/data/user_de/0/${APP}`], dest, 180_000);
  if (piped === 0 && looksLikeTar(dest)) return;
  phone.shell(`rm -f ${DATA_TAR_REMOTE}`);
  phone.shell(`tar -cf ${DATA_TAR_REMOTE} /data/data/${APP} /data/user_de/0/${APP}`);
  const pulled = captureTo(['exec-out', 'cat', DATA_TAR_REMOTE], dest, 180_000);
  phone.shell(`rm -f ${DATA_TAR_REMOTE}`);
  if (pulled !== 0 || !looksLikeTar(dest)) throw new Error('the app folders could not be read as a tar');
}

function xmlPaths(phone: Emu): string[] {
  asRoot();
  const listed = phone.shell(`find /data/data/${APP} /data/user_de/0/${APP} -name NOTIFICATION_STORE.xml -type f 2>/dev/null`);
  return pathLines(listed.out);
}

function utf8Files(phone: Emu, canary: string): string[] {
  asRoot();
  const listed = phone.shell(`grep -r -l -a -F '${canary}' /data/data/${APP} /data/user_de/0/${APP} 2>/dev/null`);
  return pathLines(listed.out);
}

function b4(phone: Emu, ctx: BCtx): void {
  const canaries = CANARY_KEYS.map(key => canaryOf(ctx.seed, key));
  const dataTar = join(ctx.dir, 'data.tar');
  const logcat = join(ctx.dir, 'logcat.txt');
  const notification = join(ctx.dir, 'notification.txt');
  const alarm = join(ctx.dir, 'alarm.txt');
  try {
    captureDataTar(phone, dataTar);
  } finally {
    removeDataTar(phone);
  }
  captureTo(['logcat', '-d', '-b', 'all'], logcat, 120_000);
  captureTo(['shell', 'dumpsys', 'notification', '--noredact'], notification, 120_000);
  captureTo(['shell', 'dumpsys', 'alarm'], alarm, 120_000);
  const backup = join(ctx.dir, 'backup.tar');
  if (!looksLikeTar(backup) && looksLikeTar(STABLE_BACKUP)) writeFileSync(backup, readFileSync(STABLE_BACKUP));
  if (!looksLikeTar(backup)) throw new Error('the backup was not read, so a canary in it would not be seen');
  const xmls = xmlPaths(phone);
  const xmlBytes: Uint8Array[] = [];
  for (const [i, path] of xmls.entries()) {
    const dest = join(ctx.dir, `notification-store-${i}.xml`);
    captureTo(['exec-out', 'cat', path], dest, 60_000);
    xmlBytes.push(new Uint8Array(readFileSync(dest)));
  }
  const sources: { name: string; hits: Hit[] }[] = [
    { name: 'data', hits: canaryHits(readSearched(dataTar, 'the app folders'), canaries) },
    { name: 'log', hits: canaryHits(readSearched(logcat, 'the log'), canaries) },
    { name: 'notif', hits: canaryHits(readSearched(notification, 'the notification dump'), canaries) },
    { name: 'alarm', hits: canaryHits(readSearched(alarm, 'the alarm dump'), canaries) },
    { name: 'backup', hits: canaryHits(readSearched(backup, 'the backup'), canaries) },
  ];
  const xmlHits = xmlBytes.flatMap(bytes => canaryHits(bytes, canaries));
  const parts: string[] = [];
  for (const key of CANARY_KEYS) {
    const canary = canaryOf(ctx.seed, key);
    const cols = sources.map(s => `${s.name}=${countOf(s.hits, canary)}`).join(' ');
    parts.push(`${key} ${cols} xml=${countOf(xmlHits, canary)}`);
  }
  ctx.note(`B4 ${parts.join('; ')}`);
  const shown = ctx.seed.canaries.shownCue;
  if (countOf(sources.find(s => s.name === 'notif')?.hits ?? [], shown) === 0) {
    throw new Error('the shown canary was not in the notification dump, so the search is not shown to work');
  }
  const where = utf8Files(phone, shown);
  ctx.note(`B4 shown utf8 in ${where.join(', ') || 'no file'}`);
  if (where.length === 0 || where.some(p => !p.includes('shared_prefs/NOTIFICATION_STORE.xml'))) {
    throw new Error(`the shown canary's files were ${where.join(', ') || 'none'}`);
  }
  if (countOf(xmlHits, shown) === 0) throw new Error('the shown canary was not in NOTIFICATION_STORE.xml');
  for (const key of CANARY_KEYS) {
    const canary = canaryOf(ctx.seed, key);
    for (const source of sources) {
      const n = countOf(source.hits, canary);
      if (!forbiddenCanary(key, source.name, n)) continue;
      throw new Error(key === 'shownCue' ? `the shown canary had ${n} hit(s) in ${source.name}` : `${key} had ${n} hit(s) in ${source.name}`);
    }
    if (forbiddenCanary(key, 'xml', countOf(xmlHits, canary))) throw new Error(`${key} was in the notification store`);
  }
  const dataHits = sources.find(s => s.name === 'data')?.hits ?? [];
  const forms = ['utf8', 'utf16le', 'utf16be', 'base64', 'base64url'] as const;
  for (const form of forms) {
    const inData = dataHits.filter(h => h.canary === shown && h.form === form).length;
    const inXml = xmlHits.filter(h => h.canary === shown && h.form === form).length;
    if (inData === 0 && inXml === 0) continue;
    if (inXml === 0 || inData % inXml !== 0 || inData / inXml > 3) {
      throw new Error(`shown ${form} hits in the data folder ${inData}, in the notification store ${inXml}`);
    }
  }
  for (const key of CANARY_KEYS) {
    if (key === 'shownCue') continue;
    const files = utf8Files(phone, canaryOf(ctx.seed, key));
    if (files.length > 0) throw new Error(`${key} was in ${files.join(', ')}`);
  }
}

function stableAppFiles(phone: Emu): string[] {
  let last = '';
  let same = 0;
  let files: string[] = [];
  const until = Date.now() + 90_000;
  while (Date.now() < until) {
    files = appFiles(phone);
    const key = files.map(relOf).sort().join('\n');
    const hasSnapshot = files.some(f => relOf(f) === 'files/backup/latest.dcbak');
    if (key === last && hasSnapshot) same += 1;
    else same = 0;
    last = key;
    if (same >= 2) return files;
    pause(2_000);
  }
  return files;
}

/** B5. Uninstall, install, and do not launch. Android puts the snapshot back. */
function wipedFiles(phone: Emu, ctx: BCtx, label: string): void {
  if (ctx.transport.applied && markedTransport(phone.shell('bmgr list transports').out) !== LOCAL) {
    useLocalTransport(phone, ctx.transport);
    ctx.note(`${label} selected the local transport again so install can restore`);
  }
  asRoot();
  guardUninstall();
  const installed = ctx.install();
  ctx.save(`${label}-install.txt`, installed);
  if (!/Installed .+ over what was there/.test(installed)) throw new Error(`the release APK did not install (${oneLine(installed)})`);
  const files = stableAppFiles(phone);
  const rels = [...new Set(files.map(relOf))].sort();
  ctx.note(`${label} files ${rels.join(', ') || 'none'}`);
  if (rels.length !== 1 || rels[0] !== 'files/backup/latest.dcbak') {
    throw new Error(`files before launch: ${rels.join(', ') || 'none'}`);
  }
}

function b5(phone: Emu, ctx: BCtx): void {
  wipedFiles(phone, ctx, 'B5');
}

function b6(phone: Emu, ctx: BCtx): void {
  wake(phone);
  launch(phone, true);
  if (!phone.waitFor(has('Your record came back with this phone'), 40_000) && !phone.waitFor(words('Restore it'), 8_000)) {
    ctx.save('b6-launch.xml', phone.lastXml());
    throw new Error(`the found copy was not offered (${brief(phone)})`);
  }
  openFoundCopy(phone, ctx);
  seeWalk(phone, ctx);
  phone.key('KEYCODE_HOME');
  pause(1_500);
  launch(phone, true);
  dismissKeyguard(phone);
  if (!phone.waitFor(words('Passphrase'), 30_000) && !phone.waitFor(words('Locked'), 8_000)) {
    ctx.save('b6-lock.xml', phone.lastXml());
    throw new Error(`the lock screen did not return (${brief(phone)})`);
  }
  const why = onlyPassphrase(phone);
  if (why !== undefined) {
    ctx.save('b6-lock.xml', phone.lastXml());
    throw new Error(why);
  }
}

function restoreByCode(phone: Emu, ctx: BCtx): void {
  wake(phone);
  launch(phone, true);
  if (!phone.waitFor(words('Restore it'), 40_000)) {
    ctx.save('b7-launch.xml', phone.lastXml());
    throw new Error(`the found copy was not offered (${brief(phone)})`);
  }
  phone.tap(words('Restore it'), 15_000);
  if (!phone.waitFor(words('Use the recovery code instead'), 25_000)) {
    ctx.save('b7-restore.xml', phone.lastXml());
    throw new Error(`the restore screen did not offer the recovery code (${brief(phone)})`);
  }
  phone.tap(words('Use the recovery code instead'), 15_000);
  const until = Date.now() + 15_000;
  let ready = false;
  for (;;) {
    if (recoveryCodeReady(phone.dump())) {
      ready = true;
      break;
    }
    if (Date.now() >= until) break;
    pause(400);
  }
  if (!ready) {
    ctx.save('b7-code.xml', phone.lastXml());
    throw new Error('the recovery code field did not replace the passphrase');
  }
  focusSecret(phone, 'Recovery code');
  phone.type(ctx.seed.recoveryCode);
  phone.tap(words('Restore'), 20_000);
  if (phone.waitFor(has('Replace everything'), 12_000)) phone.tap(words('Replace everything'), 15_000);
  if (!phone.waitFor(words('Restored'), 90_000)) {
    ctx.save('b7-result.xml', phone.lastXml());
    throw new Error(`the recovery code did not restore (${brief(phone)})`);
  }
  phone.tap(words('Open'), 20_000);
  if (!phone.waitFor(words('Passphrase'), 30_000) && !phone.waitFor(words('Locked'), 8_000)) {
    throw new Error('the restored record did not reach the lock screen');
  }
  unlock(phone, ctx.seed.passphrase);
  seeWalk(phone, ctx);
}

function b7(phone: Emu, ctx: BCtx): void {
  wipedFiles(phone, ctx, 'B7');
  restoreByCode(phone, ctx);
}

function b8(phone: Emu, ctx: BCtx): void {
  const why = putTransportBack(phone, ctx.transport);
  if (why !== undefined) throw new Error(why);
  if (ctx.transport.noted === '') throw new Error('no transport was noted');
}

export function checksB(ctx: BCtx): Check[] {
  return [
    { name: 'B0', run: phone => b0(phone, ctx) },
    { name: 'B1', run: phone => b1(phone, ctx) },
    { name: 'B2', run: phone => b2(phone, ctx) },
    { name: 'B3', run: phone => b3(phone, ctx) },
    { name: 'B4', run: phone => b4(phone, ctx) },
    { name: 'B5', run: phone => b5(phone, ctx) },
    { name: 'B6', run: phone => b6(phone, ctx) },
    { name: 'B7', run: phone => b7(phone, ctx) },
    { name: 'B8', run: phone => b8(phone, ctx) },
  ];
}
