// The U6 rehearsal, its own runner (not a stage of checks/run.ts).
// It builds the current version, builds a throwaway 0.1.1 copy, then on the test emulator
// walks a first day, a second day, and an install over the top. Stdout is one PASS/FAIL line
// per check. The clock is the emulator's own `date` after the same root step as checks/b.ts.
// Both builds finish before the emulator starts: a Gradle build will not start while one is running.
//
// node scripts/android/checks/u6.ts [--reuse] [--slot-held]
//   --reuse      keep the two APKs already built (both must exist); for a rerun after a change to this runner only
//   --slot-held  the emulator RAM slot is already granted to the caller, so skip the wait for u6-slot.txt
import { appendFileSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Platform, appInFront, focusSecret, guardUninstall, launch, locked, pastLock, scrollTo, scrollUpTo, showing, unlock } from './a.ts';
import { rootStep } from './b.ts';
import { adbOnTestPhone, dockTop, emu, pause } from '../drive.ts';
import { startEmulator, stopEmulator } from '../emulator.ts';
import { runSync } from '../proc.ts';
import { isDcTestPhone } from '../smoke.ts';
import {
  aboutOrder, CHANGED_HEADING, clockReadback, clockStamp, dateSetArg, dayNumberFrom, installWhy, nameBox, namePoint, patchAppVersion,
  patchChanges, patchPackageVersion, preupgradeNames, recoveryFromLabels, REHEARSAL_DAY,
  todayClosed, versionIs, yesterdayClosed,
} from './u6Read.ts';

const APP = 'app.dailycommit';
const PASS = 'CANARY-L2 test passphrase';
const HABIT = 'Walk';
const PHONE_ARGS = ['run', 'phone', '--', '--serial', 'emulator-5556'] as const;
const BUILD_MS = 3_000_000;
const PHONE_MS = 300_000;

class Step extends Error {
  readonly reason: string;
  constructor(reason: string) {
    super(reason);
    this.name = 'Step';
    this.reason = reason;
  }
}

function repoRoot(): string {
  return fileURLToPath(new URL('../../../', import.meta.url));
}

function isScratch(dir: string): boolean {
  const root = resolve(tmpdir());
  const abs = resolve(dir);
  const prefix = root.endsWith(sep) ? root : root + sep;
  return abs.toLowerCase().startsWith(prefix.toLowerCase()) && basename(abs) === 'dc-u6-rehearsal';
}

function redact(text: string): string {
  return text.replaceAll(PASS, '[pass]').replace(/[0-9A-HJKMNP-TV-Z]{5}(?:\s+[0-9A-HJKMNP-TV-Z]{5}){3,}/g, '[code]');
}

function withLongPath(p: string): string {
  const abs = resolve(p);
  return abs.startsWith('\\\\?\\') ? abs : `\\\\?\\${abs}`;
}

function withoutLongPath(p: string): string {
  const prefix = '\\\\?\\';
  return p.startsWith(prefix) ? p.slice(prefix.length) : p;
}

const COPY_SKIP = [
  '.git', '.local', 'dist', '_trash',
  join('android', 'app', 'build'), join('android', 'build'), join('android', '.gradle'),
];

function copyReady(dir: string): boolean {
  return existsSync(join(dir, 'package.json'))
    && existsSync(join(dir, 'node_modules', 'typescript', 'package.json'))
    && existsSync(join(dir, 'android', 'local.properties'))
    && existsSync(join(dir, 'android', 'gradlew.bat'))
    && existsSync(join(dir, 'src', 'app', 'compose.ts'))
    && existsSync(join(dir, 'src', 'settings', 'whatChanged.ts'));
}

/** A full tree copy. Robocopy treats the long-path prefix as a network path, so this uses the file API. */
function copyTree(src: string, dest: string, skipMore: readonly string[] = []): void {
  const root = resolve(src);
  const skips = [...COPY_SKIP, ...skipMore];
  cpSync(withLongPath(root), withLongPath(dest), {
    recursive: true,
    dereference: true,
    force: true,
    filter: (from: string) => {
      const rel = relative(root, resolve(withoutLongPath(from)));
      if (rel === '' || rel.startsWith('..')) return true;
      return !skips.some(skip => rel === skip || rel.startsWith(skip + sep));
    },
  });
}

function repoVersion(repo: string): string {
  try {
    const text = readFileSync(join(repo, 'package.json'), 'utf8');
    return versionIs(text, '0.1.0') ? '0.1.0' : versionIs(text, '0.1.1') ? '0.1.1' : '';
  } catch {
    return '';
  }
}

function npm(args: readonly string[], cwd: string, timeout: number): { readonly code: number; readonly out: string; readonly timedOut: boolean } {
  const ran = runSync('npm', args, { shell: true, cwd, encoding: 'utf8', windowsHide: true, timeout, maxBuffer: 16 * 1024 * 1024 });
  const err = ran.error;
  const timedOut = err instanceof Error && 'code' in err && err.code === 'ETIMEDOUT';
  return { code: ran.status ?? 1, out: `${ran.stdout ?? ''}\n${ran.stderr ?? ''}`, timedOut };
}

function reasonOf(e: unknown): string {
  if (e instanceof Step) return e.reason;
  if (e instanceof Platform) return 'Platform';
  if (e instanceof Error) return e.name === 'Error' ? 'Error' : e.name;
  return 'Error';
}

async function main(): Promise<number> {
  const repo = repoRoot();
  const reuse = process.argv.includes('--reuse');
  const slotHeld = process.argv.includes('--slot-held');
  const builtApk = (root: string): boolean => existsSync(join(root, 'android', 'app', 'build', 'outputs', 'apk', 'release', 'app-release.apk'));
  const local = join(repo, '.local', 'android');
  mkdirSync(local, { recursive: true });
  const logFile = join(local, 'u6.log');
  const slotFile = join(local, 'u6-slot.txt');
  writeFileSync(logFile, '');
  rmSync(slotFile, { force: true });
  const note = (line: string): void => {
    try { appendFileSync(logFile, `${redact(line)}\n`); } catch { /* a log line must not stop the run */ }
  };
  const write = (args: readonly unknown[]): void => note(args.map(a => (typeof a === 'string' ? a : a instanceof Error ? a.name : typeof a)).join(' '));
  console.log = (...args: unknown[]) => write(args);
  console.info = (...args: unknown[]) => write(args);
  console.warn = (...args: unknown[]) => write(args);
  console.error = (...args: unknown[]) => write(args);
  const phase = (name: string): void => { writeFileSync(join(local, 'u6-phase.txt'), name); };

  let failed = false;
  let started = false;
  let current = 'build-current';
  const said = new Set<string>();
  const say = (name: string, ok: boolean, detail: string): void => {
    if (said.has(name)) return;
    said.add(name);
    const line = `${ok ? 'PASS' : 'FAIL'} ${name} (${detail})`;
    process.stdout.write(`${line}\n`);
    note(line);
    if (!ok) failed = true;
  };

  const phone = emu();
  const texts = (): string[] => phone.dump().map(n => (n.text || n.desc).replace(/\s+/g, ' ').trim()).filter(t => t.length > 0);
  const tap = (label: RegExp, reason: string, ms = 20_000): void => {
    try { phone.tap(label, ms); } catch (e) {
      note(`tap ${reason} ${e instanceof Error ? redact(e.message) : 'Error'}`);
      throw new Step(reason);
    }
  };
  const reveal = (label: RegExp, reason: string): void => {
    try { scrollTo(phone, label); return; } catch (e) { note(`down ${reason} ${e instanceof Error ? e.name : 'Error'}`); }
    try { scrollUpTo(phone, label); } catch (e) {
      note(`up ${reason} ${e instanceof Error ? redact(e.message) : 'Error'}`);
      throw new Step(reason);
    }
  };
  // The row's centre can sit on the dock. Tap near the top of the name instead.
  const tapName = (label: RegExp, reason: string): void => {
    const size = phone.shell('wm size').out;
    const m = /Override size: (\d+)x(\d+)/.exec(size) ?? /Physical size: (\d+)x(\d+)/.exec(size);
    const w = Number(m?.[1] ?? 1080);
    const h = Number(m?.[2] ?? 2400);
    for (let i = 0; i < 8; i++) {
      const nodes = phone.dump();
      const dock = dockTop(nodes, h);
      const box = nameBox(nodes.map(n => ({
        text: (n.text || n.desc).replace(/\s+/g, ' ').trim(),
        left: n.bounds[0], top: n.bounds[1], right: n.bounds[2], bottom: n.bounds[3],
      })).filter(b => b.text.length > 0), label, dock, w, h);
      if (box) {
        const [x, y] = namePoint(box, dock);
        if (phone.shell(`input tap ${x} ${y}`).code !== 0) throw new Step(reason);
        return;
      }
      phone.shell(`input swipe ${Math.floor(w / 2)} ${Math.floor(h * 0.42)} ${Math.floor(w / 2)} ${Math.floor(h * 0.72)} 300`);
      pause(300);
    }
    throw new Step(reason);
  };
  // Mark a habit as done the way a.ts does: open its row, wait for the choices, then tap Did it.
  // Only ever scroll down here. A swipe on a page too short to move lands as a tap, and the up-scroll
  // fallback once set the habit to Partly that way.
  const markDid = (label: RegExp): void => {
    try { scrollTo(phone, label); } catch (e) { note(`habit scroll ${e instanceof Error ? e.name : 'Error'}`); throw new Step('no-habit'); }
    tapName(label, 'no-habit');
    if (!phone.waitFor(/^Did it$/, 4_000)) {
      note('did retry');
      tapName(label, 'no-habit');
      if (!phone.waitFor(/^Did it$/, 4_000)) throw new Step('no-did');
    }
    try { scrollTo(phone, /^Did it$/); } catch (e) {
      const size = phone.shell('wm size').out;
      const m = /Override size: (\d+)x(\d+)/.exec(size) ?? /Physical size: (\d+)x(\d+)/.exec(size);
      const nodes = phone.dump();
      const dock = dockTop(nodes, Number(m?.[2] ?? 2400));
      const boxes = nodes.filter(n => /^(Did it|Partly|Not today)$/.test((n.text || n.desc).trim())).map(n => n.bounds.join(','));
      note(`did under dock ${dock} boxes ${boxes.join(' ')} ${e instanceof Error ? e.name : 'Error'}`);
      throw new Step('no-did');
    }
    tap(/^Did it$/, 'no-did');
  };
  // Close today. Down-scroll only, for the same reason as Did it.
  const closeDay = (): void => {
    try { scrollTo(phone, /^That's the day\b/); } catch { throw new Step('no-close'); }
    tap(/^That's the day\b/, 'no-close');
    if (!phone.waitFor(/^Open today again$/, 20_000)) throw new Step('no-close');
    if (!todayClosed(texts())) throw new Step('no-close');
  };
  const dismiss = (): void => {
    for (let i = 0; i < 4; i++) {
      if (showing(phone, /keeps stopping/i) && (showing(phone, /^Close app$/) || showing(phone, /^Wait$/))) {
        tap(showing(phone, /^Close app$/) ? /^Close app$/ : /^Wait$/, 'no-today', 8_000);
        pause(400);
        continue;
      }
      if (showing(phone, /Let Daily Commit send reminders/)) {
        tap(/^Not now$/, 'no-today', 10_000);
        pause(400);
        continue;
      }
      return;
    }
  };
  const wake = (): void => {
    phone.key('KEYCODE_WAKEUP');
    pause(400);
    adbOnTestPhone(['shell', 'wm', 'dismiss-keyguard'], 20_000);
    pause(400);
  };
  const openApp = (): void => {
    wake();
    try { launch(phone, true); } catch (e) {
      note(`launch ${e instanceof Error ? e.name : 'Error'}`);
      throw new Step('no-today');
    }
    pause(800);
    dismiss();
  };
  const unlockSafe = (): void => {
    try { unlock(phone, PASS); } catch (e) {
      note(`unlock ${e instanceof Error ? redact(e.message) : 'Error'}`);
      throw new Step('no-today');
    }
    dismiss();
  };
  const asRoot = (): void => {
    for (let attempt = 0; attempt < 3; attempt++) {
      const id = adbOnTestPhone(['shell', 'id'], 20_000);
      if (rootStep(id.out, '') === 'root') return;
      const rooted = adbOnTestPhone(['root'], 60_000);
      const step = rootStep(id.out, rooted.out);
      if (step === 'root') return;
      if (step === 'refused') break;
      try { adbOnTestPhone(['wait-for-device'], 60_000); } catch { /* the next id is the check */ }
      pause(1_000);
    }
    const id = adbOnTestPhone(['shell', 'id'], 20_000);
    if (rootStep(id.out, '') === 'root') return;
    throw new Step('root');
  };
  const setClock = (month: number, day: number, hour: number, tag: string): void => {
    asRoot();
    adbOnTestPhone(['shell', 'settings', 'put', 'global', 'auto_time', '0'], 20_000);
    adbOnTestPhone(['shell', 'settings', 'put', 'global', 'auto_time_zone', '0'], 20_000);
    const arg = dateSetArg(month, day, hour, 0, 2026);
    const want = clockStamp(month, day, hour);
    const tries: readonly (readonly string[])[] = [['date', arg], ['toybox', 'date', arg]];
    for (const cmd of tries) {
      adbOnTestPhone(['shell', ...cmd], 20_000);
      pause(500);
      const read = adbOnTestPhone(['shell', 'date', '+%Y-%m-%dT%H'], 20_000);
      if (clockReadback(read.out, want)) {
        const which = cmd[0] === 'toybox' ? 'toybox' : 'date';
        note(`clock ${tag} ${which}`);
        appendFileSync(join(local, 'u6-clock.txt'), `${tag} ${which}\n`);
        return;
      }
      note(`clock ${tag} read ${read.out.trim()}`);
    }
    throw new Step('clock');
  };
  const stopApp = (): void => {
    adbOnTestPhone(['shell', 'am', 'force-stop', APP], 20_000);
    pause(600);
  };
  const requireDay = (labels: readonly string[]): string => {
    const day = dayNumberFrom(labels);
    if (day !== REHEARSAL_DAY) throw new Step(day === undefined ? 'absent' : String(day));
    return String(day);
  };

  try {
    phase('building');
    if (repoVersion(repo) !== '0.1.0') throw new Step('version');
    if (reuse) {
      if (!builtApk(repo)) throw new Step('no-apk');
      note('build current reuse');
    } else {
      note('build current start');
      const currentBuild = npm(['run', 'android:build'], repo, BUILD_MS);
      note(`build current exit ${currentBuild.timedOut ? 'timeout' : currentBuild.code}`);
      if (currentBuild.code !== 0) {
        note(`build current tail ${redact(currentBuild.out).replace(/\s+/g, ' ').slice(-400)}`);
        throw new Step(currentBuild.timedOut ? 'timeout' : String(currentBuild.code));
      }
    }
    say('build-current', true, reuse ? 'reused' : 'yes');

    current = 'build-rehearsal';
    const dir = join(tmpdir(), 'dc-u6-rehearsal');
    if (!isScratch(dir)) throw new Step('copy');
    // A copy left by an earlier run keeps its installed packages but always takes the repo's current source,
    // so the rehearsal build is never made from older code than the build it upgrades.
    const refresh = copyReady(dir);
    try { copyTree(repo, dir, refresh ? ['node_modules'] : []); } catch (e) {
      const code = e instanceof Error && 'code' in e && typeof e.code === 'string' ? e.code : e instanceof Error ? e.name : 'Error';
      note(`copy ${code}`);
      throw new Step('copy');
    }
    note(refresh ? 'copy refreshed' : 'copy ok');
    if (!existsSync(join(dir, 'android', 'local.properties'))) throw new Step('signing-path');
    const pkg = patchPackageVersion(readFileSync(join(repo, 'package.json'), 'utf8'));
    const appSrc = patchAppVersion(readFileSync(join(repo, 'src', 'app', 'compose.ts'), 'utf8'));
    const changes = patchChanges(readFileSync(join(repo, 'src', 'settings', 'whatChanged.ts'), 'utf8'));
    if (pkg === undefined || appSrc === undefined || changes === undefined) throw new Step('version');
    writeFileSync(join(dir, 'package.json'), pkg);
    writeFileSync(join(dir, 'src', 'app', 'compose.ts'), appSrc);
    writeFileSync(join(dir, 'src', 'settings', 'whatChanged.ts'), changes);
    if (!versionIs(readFileSync(join(dir, 'package.json'), 'utf8'), '0.1.1')) throw new Step('version');
    if (!readFileSync(join(dir, 'src', 'app', 'compose.ts'), 'utf8').includes("export const APP_VERSION = '0.1.1'")) throw new Step('version');
    if (repoVersion(repo) !== '0.1.0') throw new Step('version');
    if (reuse) {
      if (!builtApk(dir)) throw new Step('no-apk');
      note('build rehearsal reuse');
    } else {
      note('build rehearsal start');
      const rehearsalBuild = npm(['run', 'android:build'], dir, BUILD_MS);
      note(`build rehearsal exit ${rehearsalBuild.timedOut ? 'timeout' : rehearsalBuild.code}`);
      if (rehearsalBuild.code !== 0) {
        note(`build rehearsal tail ${redact(rehearsalBuild.out).replace(/\s+/g, ' ').slice(-400)}`);
        throw new Step(rehearsalBuild.timedOut ? 'timeout' : String(rehearsalBuild.code));
      }
    }
    if (repoVersion(repo) !== '0.1.0') throw new Step('version');
    say('build-rehearsal', true, reuse ? 'reused' : 'yes');

    phase('emulator');
    current = 'fresh-install';
    const slotUntil = Date.now() + 120 * 60_000;
    while (!slotHeld) {
      const slot = existsSync(slotFile) ? readFileSync(slotFile, 'utf8').trim() : '';
      if (slot === 'emulator') break;
      if (Date.now() >= slotUntil) throw new Step('slot');
      pause(2_000);
    }
    phase('session');
    started = true;
    if (!(await startEmulator())) throw new Step('boot');
    const named = adbOnTestPhone(['emu', 'avd', 'name'], 30_000);
    if (named.code !== 0 || !isDcTestPhone(named.out)) throw new Step('not-dc');
    try { guardUninstall(); } catch (e) {
      note(`uninstall ${e instanceof Error ? e.name : 'Error'}`);
      throw new Step('not-dc');
    }
    const fresh = npm(PHONE_ARGS, repo, PHONE_MS);
    const freshWhy = installWhy(fresh.out, fresh.code);
    note(`fresh install ${freshWhy}`);
    if (freshWhy !== 'yes') throw new Step(freshWhy);
    say('fresh-install', true, 'yes');

    current = 'clock';
    writeFileSync(join(local, 'u6-clock.txt'), '');
    setClock(1, 5, 20, 'day1');
    say('clock', true, 'yes');

    current = 'first-run';
    const once = (): 'ok' | 'mismatch' => {
      openApp();
      if (showing(phone, /^Start new instead$/)) tap(/^Start new instead$/, 'no-begin');
      if (!phone.waitFor(/^Begin$/, 60_000)) throw new Step('no-begin');
      reveal(/^Begin$/, 'no-begin');
      tap(/^Begin$/, 'no-begin');
      pause(500);
      // Begin sits at the bottom of the welcome page, and the next step keeps that scroll.
      // Focus as soon as the field is in view: a later wait lets the page settle off the field.
      let headed = false;
      try { scrollUpTo(phone, /^Choose a passphrase$/); headed = true; } catch { /* the field name is the other way to it */ }
      try { scrollUpTo(phone, /^Passphrase$/); } catch (e) {
        if (!headed) {
          note(`pass scroll ${e instanceof Error ? redact(e.message).slice(0, 240) : 'Error'}`);
          throw new Step('no-pass');
        }
      }
      try { focusSecret(phone, 'Passphrase'); } catch (e) {
        note(`pass ${e instanceof Error ? redact(e.message).slice(0, 240) : 'Error'}`);
        throw new Step('no-pass');
      }
      phone.type(PASS);
      pause(400);
      phone.key('KEYCODE_ENTER');
      const moving = phone.waitFor(/I've written it down|Your recovery code|Making your lock/, 8_000);
      if (!moving && showing(phone, /^Continue$/)) {
        phone.key('KEYCODE_BACK');
        pause(300);
        tap(/^Continue$/, 'no-pass');
      }
      const codeUntil = Date.now() + 180_000;
      let code: string | undefined;
      while (Date.now() < codeUntil) {
        dismiss();
        const labels = texts();
        code = recoveryFromLabels(labels);
        if (code !== undefined && labels.some(l => l.includes("I've written it down"))) break;
        pause(1_000);
      }
      if (code === undefined) throw new Step('no-code');
      if (code.length < 41) throw new Step('code-short');
      note('recovery compact yes');
      tap(/^I've written it down$/, 'no-code');
      pause(500);
      // That button is at the bottom, and the type-back step keeps the scroll.
      try { scrollUpTo(phone, /^Type it back$/); } catch (e) {
        note(`typeback scroll ${e instanceof Error ? e.name : 'Error'}`);
      }
      try { focusSecret(phone, 'Recovery code, typed back'); } catch (e) {
        note(`typeback ${e instanceof Error ? redact(e.message).slice(0, 180) : 'Error'}`);
        throw new Step('no-code');
      }
      phone.type(code);
      pause(400);
      phone.key('KEYCODE_BACK');
      pause(400);
      reveal(/^Finish$/, 'no-finish');
      tap(/^Finish$/, 'no-finish');
      const openUntil = Date.now() + 90_000;
      while (Date.now() < openUntil) {
        dismiss();
        const labels = texts();
        if (labels.some(l => l.toLowerCase().includes('doesn') && l.toLowerCase().includes('match'))) return 'mismatch';
        if (pastLock(phone.dump())) return 'ok';
        if (!appInFront(phone)) phone.key('KEYCODE_BACK');
        pause(700);
      }
      throw new Step('no-finish');
    };
    let first = once();
    if (first === 'mismatch') {
      note('first run mismatch, retry');
      stopApp();
      first = once();
    }
    if (first !== 'ok') throw new Step('mismatch');
    dismiss();
    say('first-run', true, 'yes');

    current = 'day-one-closed';
    tap(/^Plan$/, 'no-habit');
    pause(500);
    reveal(/^Add to Log$/, 'no-habit');
    tap(/^Add to Log$/, 'no-habit');
    pause(400);
    try { scrollUpTo(phone, /^Something new$/); } catch (e) {
      note(`habit scroll ${e instanceof Error ? e.name : 'Error'}`);
      throw new Step('no-habit');
    }
    // The name's label is not the field. Tap the field itself, or just under the label.
    const nameUntil = Date.now() + 8_000;
    let tapped = false;
    while (Date.now() < nameUntil) {
      const nodes = phone.dump();
      const field = nodes.find(n => n.cls.includes('EditText') && n.bounds[2] > n.bounds[0] + 8 && n.bounds[3] > n.bounds[1] + 8);
      const label = nodes.find(n => (n.text || n.desc).trim() === 'Name');
      const bounds = field?.bounds ?? (label ? [label.bounds[0], label.bounds[3] + 8, label.bounds[2], label.bounds[3] + 56] as const : undefined);
      if (bounds) {
        const x = Math.floor((bounds[0] + bounds[2]) / 2);
        const y = Math.floor((bounds[1] + bounds[3]) / 2);
        if (phone.shell(`input tap ${x} ${y}`).code !== 0) throw new Step('no-habit');
        tapped = true;
        break;
      }
      pause(300);
    }
    if (!tapped) throw new Step('no-habit');
    pause(300);
    phone.type(HABIT);
    pause(300);
    phone.key('KEYCODE_BACK');
    pause(400);
    reveal(/^Save$/, 'no-habit');
    tap(/^Save$/, 'no-habit');
    const savedUntil = Date.now() + 20_000;
    let saved = false;
    while (Date.now() < savedUntil) {
      const labels = texts();
      if (labels.some(l => l === HABIT || l.startsWith(`${HABIT} `)) && !labels.includes('Something new')) { saved = true; break; }
      pause(500);
    }
    if (!saved) { note('habit unsaved'); throw new Step('no-habit'); }
    const habitLabel = new RegExp(`^${HABIT}\\b`);
    tap(/^Today$/, 'no-today');
    pause(500);
    markDid(habitLabel);
    pause(400);
    closeDay();
    say('day-one-closed', true, 'yes');

    current = 'day-two-closed';
    setClock(1, 6, 20, 'day2');
    stopApp();
    openApp();
    if (locked(phone)) unlockSafe();
    if (!pastLock(phone.dump())) throw new Step('no-today');
    tap(/^Today$/, 'no-today');
    pause(400);
    markDid(habitLabel);
    pause(400);
    closeDay();
    reveal(/^Yesterday,/, 'no-yesterday');
    tap(/^Yesterday,/, 'no-yesterday');
    if (!phone.waitFor(/^Open it again$/, 20_000)) throw new Step('no-yesterday');
    if (!yesterdayClosed(texts())) throw new Step('no-yesterday');
    tap(/^Look back$/, 'absent');
    pause(600);
    try { reveal(/^Day \d+/, 'absent'); } catch (e) { if (!(e instanceof Step)) throw e; }
    requireDay(texts());
    say('day-two-closed', true, 'yes');

    current = 'upgrade-install';
    const upgraded = npm(PHONE_ARGS, dir, PHONE_MS);
    const upgradeWhy = installWhy(upgraded.out, upgraded.code);
    note(`upgrade install ${upgradeWhy}`);
    if (upgradeWhy !== 'yes') throw new Step(upgradeWhy);
    say('upgrade-install', true, 'yes');

    stopApp();
    openApp();
    const attempt = (name: string, fn: () => string): boolean => {
      current = name;
      try { say(name, true, fn()); return true; } catch (e) { say(name, false, reasonOf(e)); return false; }
    };
    const opened = attempt('unlock', () => {
      if (locked(phone)) unlockSafe();
      dismiss();
      if (!pastLock(phone.dump())) throw new Step('no-today');
      return 'yes';
    });
    let lookLabels: string[] = [];
    if (opened) {
      attempt('today-closed', () => {
        tap(/^Today$/, 'no-today');
        pause(500);
        if (!phone.waitFor(/^Open today again$/, 20_000)) throw new Step('no-close');
        if (!todayClosed(texts())) throw new Step('no-close');
        return 'yes';
      });
      attempt('yesterday-closed', () => {
        reveal(/^Yesterday,/, 'no-yesterday');
        tap(/^Yesterday,/, 'no-yesterday');
        if (!phone.waitFor(/^Open it again$/, 20_000)) throw new Step('no-yesterday');
        if (!yesterdayClosed(texts())) throw new Step('no-yesterday');
        return 'yes';
      });
      attempt('look-back', () => {
        tap(/^Look back$/, 'absent');
        pause(600);
        try { reveal(/^Day \d+/, 'absent'); } catch (e) { if (!(e instanceof Step)) throw e; }
        lookLabels = texts();
        return requireDay(lookLabels);
      });
      attempt('about-order', () => {
        tap(/^Plan$/, 'about');
        pause(400);
        reveal(/^Settings$/, 'about');
        tap(/^Settings$/, 'about');
        pause(600);
        let labels = texts();
        if (aboutOrder(labels) === 'missing') {
          try { reveal(CHANGED_HEADING, 'about'); } catch {
            reveal(/^About$/i, 'about');
            tap(/^About$/i, 'about');
            pause(400);
            reveal(CHANGED_HEADING, 'about');
          }
          labels = texts();
        }
        // The list sits under its heading, often below the fold: bring the oldest line into view, then read
        if (aboutOrder(labels) === 'missing') {
          try { scrollTo(phone, /^0\.1\.0/); } catch { /* read what is there */ }
          labels = texts();
        }
        const order = aboutOrder(labels);
        if (order !== 'yes') {
          const at = labels.findIndex(l => /^About$|What changed/i.test(l));
          note(`about screen (${labels.length} words, about at ${at}) ${labels.slice(Math.max(0, at)).join(' | ').slice(0, 1500)}`);
          throw new Step(order);
        }
        return 'yes';
      });
      attempt('day-n', () => requireDay(lookLabels.length > 0 ? lookLabels : texts()));
    }
    attempt('preupgrade', () => {
      asRoot();
      const lines: string[] = [];
      for (const folder of [`/data/user/0/${APP}/files/preupgrade`, `/data/data/${APP}/files/preupgrade`]) {
        lines.push(...adbOnTestPhone(['shell', 'ls', '-1', folder], 20_000).out.split(/\r?\n/));
      }
      // openStorage keeps a pre-upgrade copy only before a schema upgrade. This update changes the app, not the
      // schema, so the right answer is none: the record was opened as it was, not migrated.
      const names = preupgradeNames(lines);
      note(`preupgrade ${names.length}`);
      if (names.length !== 0) throw new Step(String(names.length));
      return 'none';
    });
  } catch (e) {
    note(e instanceof Error ? e.name : 'Error');
    // The test phone holds only invented data, so its screen words go to the local log for the failing step
    if (started) { try { note(`screen ${texts().join(' | ').slice(0, 1500)}`); } catch { /* the phone may be gone */ } }
    say(current, false, reasonOf(e));
  } finally {
    if (started) {
      try { await stopEmulator(); } catch (e) { note(e instanceof Error ? e.name : 'Error'); }
    }
  }
  if (repoVersion(repo) !== '0.1.0') say('version', false, 'version');
  phase(failed ? 'failed' : 'done');
  return failed ? 1 : 0;
}

if (import.meta.main) process.exitCode = await main();
