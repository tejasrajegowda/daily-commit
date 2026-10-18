// Task 8a's checks. Each one throws on a failure of ours. A platform behaviour throws Platform,
// which the run records and does not treat as a bug to patch around.
import { Buffer } from 'node:buffer';
import { writeFileSync } from 'node:fs';
import { isDcTestPhone, windowIsSecure } from '../smoke.ts';
import { aboveDock, adbOnTestPhone, centre, dockTop, find, findClickable, inView, onScreen, pause, pickerMove, type Emu, type UiNode } from '../drive.ts';
import { canaryHits } from './canary.ts';
import { devtoolsOnImage, devtoolsSocket, ourAlarms, ourNotifications, ourTaskId, resumedActivity } from './dumps.ts';
import { secureCapture } from './screen.ts';
import type { Seed } from './seed.ts';

export class Platform extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'Platform';
  }
}

export interface Check {
  readonly name: string;
  run(phone: Emu): void | Promise<void>;
}

export interface RunCtx {
  readonly dir: string;
  seed: Seed;
  cues: { shown: number; private: number };
  seededAtSec: number;
  note(line: string): void;
  save(name: string, data: string | Uint8Array): void;
  install(): string;
  reseed(phone: Emu): Promise<void>;
}

const APP = 'app.dailycommit';
const PIN = '1111';

function rx(label: string, whole: boolean): RegExp {
  const body = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(whole ? `^${body}$` : body, 'i');
}
const words = (label: string) => rx(label, true);
const has = (label: string) => rx(label, false);

function seen(nodes: readonly UiNode[], label: string | RegExp): boolean {
  return find(nodes, label) !== undefined;
}

/** The record is open: Today, its dock, or the reminder ask that replaces Today. The lock screen is none of these. */
export function recordOpened(nodes: readonly UiNode[]): boolean {
  return seen(nodes, words('Walk')) || seen(nodes, words('Today')) || seen(nodes, words('Diary'))
    || seen(nodes, words('Plan')) || seen(nodes, words('Let Daily Commit send reminders'));
}

/** The timing sample is taken on the lock screen. An open record is locked first; anything else waits. */
export function timingStep(open: boolean, onLock: boolean): 'measure' | 'lock' | 'wait' {
  if (onLock && !open) return 'measure';
  if (open) return 'lock';
  return 'wait';
}

/** The record is really open. A lock screen that also exposes the dock still says Locked. */
export function pastLock(nodes: readonly UiNode[]): boolean {
  return recordOpened(nodes) && !seen(nodes, words('Locked'));
}

/** A snapshot file for this task. No line means the store has none, and the check can still fail. */
export function recentsPicture(listing: string, taskId: number): string | undefined {
  const pics = listing.split(/\r?\n/).filter(l => new RegExp(`(^|\\s)${taskId}(_reduced)?\\.jpg\\b`).test(l));
  if (pics.length === 0) return undefined;
  return `recents kept ${pics.length} snapshot file(s) for task ${taskId}`;
}

/** A fingerprint touch counts only while the prompt is up and the record is still locked. Eight matches enrolment. */
export function fingerStep(open: boolean, prompt: boolean, touches: number): 'done' | 'touch' | 'wait' {
  if (open) return 'done';
  if (prompt && touches < 8) return 'touch';
  return 'wait';
}

/** The focused window only. A finished PIN screen stays in the back stack and must not count. */
export function focusIsCredential(dump: string): boolean {
  const focus = dump.split('\n').find(line => line.includes('mCurrentFocus')) ?? '';
  return /ConfirmDeviceCredential|BiometricPrompt|ConfirmLock/.test(focus);
}

/** The sensor is on this prompt. Touch it before Use PIN: on this image Use PIN removes the sensor and shows no field. */
export function sensorBeforePin(labels: readonly string[]): boolean {
  return labels.some(label => label.toLowerCase().includes('touch the fingerprint sensor'));
}

/** Once a fingerprint exists, the prompt offers Use PIN and the sensor. Use PIN is the path the driver can type. */
export function credentialAction(labels: readonly string[]): 'use-pin' | 'finger' | 'type' {
  const lower = labels.map(label => label.trim().toLowerCase());
  if (lower.includes('use pin')) return 'use-pin';
  if (lower.some(label => label.includes('touch the fingerprint sensor'))) return 'finger';
  return 'type';
}

function screenOf(phone: Emu): readonly [number, number] {
  const out = phone.shell('wm size').out;
  const m = /Override size: (\d+)x(\d+)/.exec(out) ?? /Physical size: (\d+)x(\d+)/.exec(out);
  return [Number(m?.[1] ?? 1080), Number(m?.[2] ?? 2400)];
}

function swipe(phone: Emu, yFrom: number, yTo: number): void {
  const [w, h] = screenOf(phone);
  const x = Math.floor(w / 2);
  const y1 = Math.min(h - 1, Math.max(0, yFrom));
  const y2 = Math.min(h - 1, Math.max(0, yTo));
  phone.shell(`input swipe ${x} ${y1} ${x} ${y2} 300`);
}

function swipeUp(phone: Emu): void {
  const [, h] = screenOf(phone);
  swipe(phone, Math.floor(h * 0.78), Math.floor(h * 0.32));
}

function wakeSwipe(phone: Emu): void {
  phone.key('KEYCODE_WAKEUP');
  pause(800);
  const [, h] = screenOf(phone);
  swipe(phone, Math.floor(h * 0.8), Math.floor(h * 0.3));
  pause(600);
}

export function scrollTo(phone: Emu, label: string | RegExp): void {
  const [w, h] = screenOf(phone);
  for (let i = 0; i < 14; i++) {
    const nodes = phone.dump();
    // A row can be in the tree and on the screen while the dock covers its centre. Tapping there hits the dock.
    const top = dockTop(nodes, h);
    const shown = nodes.some(n => hitNode(n, label) && aboveDock(n, w, h, top));
    if (shown) return;
    swipeUp(phone);
    pause(350);
  }
  const name = typeof label === 'string' ? label : label.source;
  const labels = nodeLabels(phone.dump()).map(t => t.replace(/\s+/g, ' ').trim()).filter(t => t.length > 0 && t.length < 60).slice(0, 8);
  throw new Error(`${name} was not on screen (${labels.join(' | ') || 'no words'})`);
}

function hitNode(n: UiNode, label: string | RegExp): boolean {
  return find([n], label) !== undefined;
}

export function launch(phone: Emu, wait: boolean): void {
  const cmd = wait ? `am start -W -n ${APP}/.MainActivity` : `am start -n ${APP}/.MainActivity`;
  let last = 'no output';
  for (let i = 0; i < 4; i++) {
    const r = wait ? adbOnTestPhone(['shell', cmd], 120_000) : phone.shell(cmd);
    if (r.code === 0) return;
    last = r.out.replace(/\s+/g, ' ').trim().slice(0, 180) || `code ${r.code}`;
    pause(800);
  }
  throw new Error(`the activity did not start (${last})`);
}

export function showing(phone: Emu, label: string | RegExp): boolean {
  return seen(phone.dump(), label);
}

function dismissOffer(phone: Emu): void {
  if (showing(phone, has('Let Daily Commit send reminders'))) phone.tap(words('Not now'), 10_000);
}

export function locked(phone: Emu): boolean {
  const nodes = phone.dump();
  return seen(nodes, words('Locked')) || (seen(nodes, words('Passphrase')) && seen(nodes, words('Open')) && !seen(nodes, has('Restore from a backup')));
}

export function focusSecret(phone: Emu, label: string): void {
  const until = Date.now() + 12_000;
  let nodes = phone.dump();
  for (;;) {
    const named = find(nodes, words(label));
    if (named && onScreen(named)) {
      phone.tap(words(label), 8_000);
      return;
    }
    const field = nodes.find(n => n.cls.includes('EditText') && onScreen(n));
    if (field) {
      const [x, y] = centre(field);
      phone.shell(`input tap ${x} ${y}`);
      pause(300);
      return;
    }
    if (Date.now() >= until) break;
    pause(400);
    nodes = phone.dump();
  }
  const labels = nodeLabels(nodes).map(t => t.replace(/\s+/g, ' ').trim()).filter(t => t.length > 0 && t.length < 60).slice(0, 8);
  throw new Error(`the ${label} field was not on screen (${labels.join(' | ') || 'no words'})`);
}

export function unlock(phone: Emu, passphrase: string): void {
  leavePrompt(phone);
  if (showing(phone, words('Use your passphrase'))) {
    phone.tap(words('Use your passphrase'), 15_000);
    if (!phone.waitFor(words('Passphrase'), 10_000)) {
      leavePrompt(phone);
      phone.tap(words('Use your passphrase'), 10_000);
    }
  }
  focusSecret(phone, 'Passphrase');
  phone.type(passphrase);
  pause(400);
  // Enter submits the lock form. The Open button leaves the tree while the keyboard is up.
  phone.key('KEYCODE_ENTER');
  pause(600);
  let nodes = phone.dump();
  if (!pastLock(nodes) && seen(nodes, words('Open'))) phone.tap(words('Open'), 10_000);
  const until = Date.now() + 60_000;
  nodes = phone.dump();
  while (!pastLock(nodes) && Date.now() < until) {
    pause(700);
    nodes = phone.dump();
  }
  if (!pastLock(nodes)) {
    const labels = nodeLabels(nodes).map(t => t.replace(/\s+/g, ' ').trim()).filter(t => t.length > 0 && t.length < 80).slice(0, 8);
    throw new Error(`the record did not open (${labels.join(' | ') || 'no words'})`);
  }
}

export function appInFront(phone: Emu): boolean {
  const resumed = resumedActivity(phone.shell('dumpsys activity activities').out) ?? '';
  if (resumed.startsWith(`${APP}/`)) return true;
  const out = phone.shell('dumpsys window').out;
  const focus = out.split('\n').find(line => line.includes('mCurrentFocus')) ?? '';
  // A finished settings screen leaves our activity in the back stack. Only the focused window counts.
  if (focus.includes('mCurrentFocus=null') || !focus.includes('/')) return out.includes(`${APP}/.MainActivity`);
  return focus.includes(`${APP}/`);
}

export function dismissKeyguard(phone: Emu): void {
  for (let i = 0; i < 3; i++) {
    const nodes = phone.dump();
    const system = seen(nodes, has('Wifi signal')) || seen(nodes, has('Battery charging'));
    const ours = seen(nodes, words('Locked')) || recordOpened(nodes) || seen(nodes, words('Passphrase')) || seen(nodes, words('Restore it'));
    if (ours || !system) return;
    wakeSwipe(phone);
    pause(400);
    for (const digit of PIN) phone.key(`KEYCODE_${digit}`);
    phone.key('KEYCODE_ENTER');
    pause(800);
  }
}

function ensureOpen(phone: Emu, ctx: RunCtx): void {
  dismissKeyguard(phone);
  if (!appInFront(phone)) launch(phone, true);
  const until = Date.now() + 60_000;
  let drew = false;
  let marker = '';
  let stable = 0;
  let drawnNodes: readonly UiNode[] = [];
  while (Date.now() < until) {
    const nodes = phone.dump();
    // Filling the shared volume makes android.process.media crash over the app. Close that dialog.
    if (seen(nodes, has('keeps stopping')) && (seen(nodes, words('Close app')) || seen(nodes, words('Wait')))) {
      const which = seen(nodes, words('Close app')) ? 'Close app' : 'Wait';
      phone.tap(words(which), 8_000);
      pause(400);
      continue;
    }
    // The launcher icon is also named Daily Commit, so that word alone is not the app.
    const now = seen(nodes, words('Restore it')) ? 'restore'
      : seen(nodes, words('Locked')) || (seen(nodes, words('Passphrase')) && seen(nodes, words('Open'))) ? 'locked'
      : recordOpened(nodes) ? 'open'
      : seen(nodes, has('Let Daily Commit send reminders')) ? 'reminder'
      : '';
    if (now !== '' && now === marker) stable += 1;
    else stable = now === '' ? 0 : 1;
    marker = now;
    if (stable >= 2) {
      drew = true;
      drawnNodes = nodes;
      break;
    }
    pause(700);
  }
  if (!drew) {
    ctx.save('not-drawn.xml', phone.lastXml());
    const front = resumedActivity(phone.shell('dumpsys activity activities').out) ?? 'none';
    const labels = nodeLabels(phone.dump()).map(t => t.replace(/\s+/g, ' ').trim()).filter(t => t.length > 0 && t.length < 60).slice(0, 8);
    throw new Error(`the app did not draw (front ${front}; ${labels.join(' | ') || 'no words'})`);
  }
  ctx.note(`drawn ${marker}: ${nodeLabels(drawnNodes).map(t => t.replace(/\s+/g, ' ').trim()).filter(t => t.length > 0 && t.length < 40).slice(0, 6).join(' | ')}`);
  if (showing(phone, words('Restore it'))) {
    ctx.note('a cold boot offered the copy Android restored; opening it with the passphrase');
    openFoundCopy(phone, ctx);
  }
  dismissOffer(phone);
  // A separate code, once set, is the pad. The passphrase field is the other lock.
  if (codePad(phone)) enterDigits(phone, '111111', 'Open');
  else if (locked(phone) || showing(phone, words('Passphrase'))) unlock(phone, ctx.seed.passphrase);
  dismissOffer(phone);
}

export function openFoundCopy(phone: Emu, ctx: RunCtx): void {
  phone.tap(words('Restore it'), 15_000);
  if (!phone.waitFor(has('Choose another file'), 25_000) && !phone.waitFor(words('Passphrase'), 8_000)) {
    throw new Error('the restored copy did not open the restore screen');
  }
  focusSecret(phone, 'Passphrase');
  phone.type(ctx.seed.passphrase);
  phone.tap(words('Restore'), 20_000);
  if (phone.waitFor(has('Replace everything'), 12_000)) phone.tap(words('Replace everything'), 15_000);
  if (!phone.waitFor(words('Restored'), 90_000)) throw new Error('the restored copy did not open');
  phone.tap(words('Open'), 20_000);
  // Open leaves the restored record on its lock screen; the passphrase field arrives with resume().
  if (!phone.waitFor(words('Passphrase'), 30_000) && !phone.waitFor(words('Locked'), 8_000)) {
    throw new Error('the restored copy did not reach the lock screen');
  }
  unlock(phone, ctx.seed.passphrase);
}

function openSettings(phone: Emu, ctx: RunCtx): void {
  ensureOpen(phone, ctx);
  if (showing(phone, words('Privacy')) && showing(phone, words('Settings'))) return;
  if (!showing(phone, words('Settings'))) phone.tap(words('Plan'), 20_000);
  phone.tap(words('Settings'), 20_000);
  scrollTo(phone, words('Privacy'));
}

function openRestore(phone: Emu, ctx: RunCtx): void {
  ensureOpen(phone, ctx);
  if (showing(phone, has('Choose a file'))) return;
  openSettings(phone, ctx);
  scrollTo(phone, has('Restore from a backup'));
  const [w, h] = screenOf(phone);
  const hits = phone.dump().filter(n => hitNode(n, has('Restore from a backup')));
  ctx.save('restore-row.xml', phone.lastXml());
  ctx.note(`restore row: ${hits.length} node(s), ${hits.filter(n => n.enabled).length} enabled, ${hits.filter(n => inView(n, w, h)).length} in view`);
  phone.tap(has('Restore from a backup'), 20_000);
  if (!phone.waitFor(has('Choose a file'), 20_000)) throw new Error('the restore screen did not open');
}

export function pushSeed(ctx: RunCtx, remote: string): void {
  const path = `${ctx.dir}/${remote}`;
  writeFileSync(path, ctx.seed.file);
  const pushed = adbOnTestPhone(['push', path, `/sdcard/Download/${remote}`], 60_000);
  if (pushed.code !== 0) throw new Error('the seed could not be copied to Download');
  adbOnTestPhone(['shell', `am broadcast -a android.intent.action.MEDIA_SCANNER_SCAN_FILE -d file:///sdcard/Download/${remote}`], 20_000);
}

function tapOnScreen(phone: Emu, label: string | RegExp, timeoutMs: number): boolean {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const nodes = phone.dump();
    const node = findClickable(nodes, label) ?? find(nodes, label);
    if (node && onScreen(node)) {
      const [x, y] = centre(node);
      phone.shell(`input tap ${x} ${y}`);
      return true;
    }
    swipeUp(phone);
    pause(400);
  }
  return false;
}

function nodeLabels(nodes: readonly UiNode[]): string[] {
  const labels: string[] = [];
  for (const node of nodes) {
    if (node.text !== '') labels.push(node.text);
    if (node.desc !== '') labels.push(node.desc);
  }
  return labels;
}

function tapNode(phone: Emu, nodes: readonly UiNode[], label: string | RegExp): void {
  const node = findClickable(nodes, label) ?? find(nodes, label);
  if (!node) return;
  const [x, y] = centre(node);
  phone.shell(`input tap ${x} ${y}`);
}

function pickFile(phone: Emu, ctx: RunCtx, fileName: string): void {
  const file = has(fileName);
  const stem = has('dc-seed');
  const until = Date.now() + 50_000;
  let inList = false;
  let nodes = phone.dump();
  while (Date.now() < until) {
    nodes = phone.dump();
    if (seen(nodes, words('Passphrase')) || seen(nodes, words('Choose another file'))) return;
    const move = pickerMove(nodeLabels(nodes), inList);
    if (move === 'file') {
      tapNode(phone, nodes, find(nodes, file) ? file : stem);
      pause(700);
      const after = phone.dump();
      if (seen(after, words('Passphrase'))) return;
      for (const label of ['Open', 'Select', 'Done']) {
        if (!findClickable(after, words(label))) continue;
        tapNode(phone, after, words(label));
        if (phone.waitFor(words('Passphrase'), 12_000)) return;
      }
    } else if (move === 'downloads') {
      tapNode(phone, nodes, has('Downloads'));
      inList = true;
      pause(600);
    } else if (move === 'roots') {
      tapNode(phone, nodes, has('Show roots'));
      pause(600);
    } else {
      swipeUp(phone);
    }
    pause(400);
  }
  ctx.save('picker-last.xml', phone.lastXml());
  const preview = nodeLabels(nodes).slice(0, 30).join(' | ').slice(0, 400);
  ctx.note(`picker showed: ${preview || 'no words'}`);
  const listed = adbOnTestPhone(['shell', 'ls /sdcard/Download']).out.split(/\r?\n/).filter(l => l.includes('dc-seed')).length;
  throw new Error(`the backup was not in the picker (${listed} seed name(s) in Download)`);
}

export function restoreSeed(phone: Emu, ctx: RunCtx, remote: string, fromWelcome: boolean): void {
  if (fromWelcome) {
    if (showing(phone, words('Choose again'))) phone.tap(words('Choose again'), 15_000);
    else if (!showing(phone, has('Choose a file')) && !showing(phone, words('Choose another file'))) {
      if (!tapOnScreen(phone, has('Restore from a backup instead'), 30_000)) throw new Error('the welcome screen did not offer restore');
    }
  } else {
    openRestore(phone, ctx);
  }
  phone.tap(has('Choose a file'), 20_000);
  pickFile(phone, ctx, remote);
  focusSecret(phone, 'Passphrase');
  phone.type(ctx.seed.passphrase);
  phone.tap(words('Restore'), 20_000);
  if (phone.waitFor(has('Replace everything'), 12_000)) phone.tap(words('Replace everything'), 15_000);
  if (!phone.waitFor(words('Restored'), 90_000)) throw new Error('restore did not finish');
  phone.tap(words('Open'), 20_000);
  unlock(phone, ctx.seed.passphrase);
}

function credentialInFront(phone: Emu): boolean {
  return focusIsCredential(phone.shell('dumpsys window').out);
}

function confirmPin(phone: Emu, ctx?: RunCtx): void {
  const until = Date.now() + 20_000;
  let nodes = phone.dump();
  while (Date.now() < until && !credentialInFront(phone) && seen(nodes, has('DAY AND TIME')) && !seen(nodes, has('PIN'))) {
    pause(400);
    nodes = phone.dump();
  }
  if (!credentialInFront(phone) && !seen(nodes, has('PIN'))) {
    const waitFront = Date.now() + 12_000;
    while (Date.now() < waitFront && !credentialInFront(phone)) pause(400);
  }
  ctx?.note(`A12 credential activity ${credentialInFront(phone) ? 'in front' : 'not in front'}`);
  const labels = nodeLabels(nodes).map(t => t.replace(/\s+/g, ' ').trim()).filter(t => t.length > 0 && t.length < 60).slice(0, 8);
  ctx?.note(`A12 pin screen: ${labels.join(' | ') || 'no words'}`);
  if (seen(nodes, has('DAY AND TIME')) && !seen(nodes, has('PIN'))) {
    ctx?.save('a12-pin.xml', phone.lastXml());
    throw new Error(`the PIN prompt did not appear (${labels.join(' | ') || 'no words'})`);
  }
  const action = credentialAction(labels);
  if (sensorBeforePin(labels)) {
    for (let i = 0; i < 4 && credentialInFront(phone); i++) {
      phone.finger();
      pause(700);
    }
    if (!credentialInFront(phone)) return;
    nodes = phone.dump();
  }
  if (action === 'use-pin' && seen(nodes, words('Use PIN'))) {
    phone.tap(words('Use PIN'), 8_000);
    pause(700);
    nodes = phone.dump();
    ctx?.note(`A12 after Use PIN: ${brief(nodes)}`);
  } else if (action === 'finger') {
    for (let i = 0; i < 4 && credentialInFront(phone); i++) {
      phone.finger();
      pause(700);
    }
    if (!credentialInFront(phone)) return;
    nodes = phone.dump();
  }
  const field = nodes.find(n => n.cls.includes('EditText') && onScreen(n));
  if (field) {
    const [x, y] = centre(field);
    phone.shell(`input tap ${x} ${y}`);
    pause(300);
    phone.type(PIN);
  } else {
    for (const digit of PIN) phone.key(`KEYCODE_${digit}`);
  }
  phone.key('KEYCODE_ENTER');
  pause(1200);
  const after = phone.dump();
  if (!seen(after, has('PIN'))) return;
  const button = findClickable(after, words('Enter')) ?? findClickable(after, words('OK')) ?? findClickable(after, words('Continue'));
  if (button) {
    const [x, y] = centre(button);
    phone.shell(`input tap ${x} ${y}`);
    pause(1200);
  }
}

function enrolPhoneLock(phone: Emu, ctx: RunCtx): void {
  const set = phone.shell(`locksettings set-pin ${PIN}`);
  if (set.code !== 0) throw new Error('the screen lock could not be set');
  // With no fingerprint enrolled, this image's prompt has no PIN control. Settings enrolment is the sensor the emulator accepts.
  if (!enrolDeviceFinger(phone, ctx, false)) ctx.note('A12 device fingerprint was not enrolled before the phone-lock prompt');
  openSettings(phone, ctx);
  scrollTo(phone, has("Your phone's lock"));
  phone.tap(has("Your phone's lock"), 20_000);
  pause(800);
  if (showing(phone, words('Today')) || showing(phone, words('Walk'))) {
    ctx.note(`A12 the phone-lock row tap left the record (${brief(phone.dump())})`);
    openSettings(phone, ctx);
    scrollTo(phone, has("Your phone's lock"));
    phone.tap(has("Your phone's lock"), 20_000);
  }
  // The privacy row always says "Anyone who knows that PIN". Only the setup page says Android asks twice.
  if (!phone.waitFor(has('Android asks twice'), 8_000)) {
    const labels = nodeLabels(phone.dump()).map(t => t.replace(/\s+/g, ' ').trim()).filter(t => t.length > 0 && t.length < 60).slice(0, 8);
    throw new Error(`the phone-lock page did not say Android asks twice (${labels.join(' | ') || 'no words'})`);
  }
  focusSecret(phone, 'Passphrase');
  phone.type(ctx.seed.passphrase);
  phone.tap(words('Continue'), 15_000);
  confirmPin(phone, ctx);
  confirmPin(phone, ctx);
  leavePrompt(phone);
  // The privacy row's warning is always in the copy, and WebView omits it until it is scrolled on.
  // The lock screen offers the phone way only once the copy was kept.
  phone.key('KEYCODE_HOME');
  pause(500);
  launch(phone, true);
  dismissKeyguard(phone);
  const offered = phone.waitFor(has("Use your phone's PIN or pattern"), 15_000) || phone.waitFor(has('Unlock with fingerprint'), 6_000);
  if (!offered) {
    ctx.save('a12-after-pin.xml', phone.lastXml());
    throw new Platform(`the credential prompt did not accept the PIN (${brief(phone.dump())})`);
  }
  ctx.note('A12 phone lock is offered on the lock screen');
}

/** Available 1K-blocks. The device name can contain digits (dm-34), so the column is the number before the Use%. */
export function availKb(df: string): number {
  const line = df.split(/\r?\n/).map(l => l.trim()).find(l => /\d+%/.test(l));
  const parts = (line ?? '').split(/\s+/);
  const useAt = parts.findIndex(p => /^\d+%$/.test(p));
  const avail = useAt > 0 ? Number(parts[useAt - 1]) : Number.NaN;
  if (!Number.isFinite(avail)) throw new Error('df /data had no available size');
  return avail;
}

function logMessages(phone: Emu): string[] {
  return phone.shell('logcat -d -s DailyCommit:V').out.split(/\r?\n/).flatMap(line => {
    if (line.startsWith('---------') || line.trim() === '') return [];
    const message = /DailyCommit(?:\(\s*\d+\))?\s*:\s*(.*)$/.exec(line)?.[1]?.trim();
    return message ? [message] : [];
  });
}

function deviceSec(phone: Emu): number {
  const sec = Number(phone.shell('date +%s').out.trim());
  if (!Number.isFinite(sec) || sec < 1_000_000_000) throw new Error('the emulator clock could not be read');
  return sec;
}

function grab(phone: Emu, ctx: RunCtx, name: string): readonly UiNode[] {
  const nodes = phone.dump();
  ctx.save(name, phone.lastXml());
  return nodes;
}

function lockShown(nodes: readonly UiNode[]): boolean {
  return seen(nodes, words('Use your passphrase')) || (seen(nodes, words('Locked')) && (seen(nodes, words('Passphrase')) || seen(nodes, words('Open'))));
}

function habitShown(nodes: readonly UiNode[]): boolean {
  return seen(nodes, words('Walk'));
}

/** A fresh test phone through to the reminder that fires with the phone asleep. */
export function checksA(ctx: RunCtx): Check[] {
  return [
    { name: 'A0', run: phone => a0(phone, ctx) },
    { name: 'A1', run: phone => a1(phone, ctx) },
    { name: 'A2', run: phone => a2(phone, ctx) },
    { name: 'A3', run: phone => a3(phone, ctx) },
    { name: 'A4', run: phone => a4(phone, ctx) },
    { name: 'A5', run: phone => a5(phone, ctx) },
    { name: 'A6', run: phone => a6(phone, ctx) },
    { name: 'A7', run: phone => a7(phone, ctx) },
    { name: 'A8', run: phone => a8(phone, ctx) },
    { name: 'A9', run: phone => a9(phone, ctx) },
    { name: 'A10', run: phone => a10(phone, ctx) },
    { name: 'A11', run: phone => a11(phone, ctx) },
    { name: 'A12', run: phone => a12(phone, ctx) },
    { name: 'A13', run: phone => a13(phone, ctx) },
    { name: 'A14', run: phone => a14(phone, ctx) },
    { name: 'A15', run: phone => a15(phone, ctx) },
    { name: 'A16', run: phone => a16(phone, ctx) },
    { name: 'A17', run: phone => a17(phone, ctx) },
    { name: 'A18', run: phone => a18(phone, ctx) },
  ];
}

function assertDcPhone(why: string): void {
  const named = adbOnTestPhone(['emu', 'avd', 'name'], 30_000);
  const shown = named.out.split(/\r?\n/).map(l => l.trim()).find(l => l !== '') ?? 'unreadable';
  if (named.code !== 0 || !isDcTestPhone(named.out)) throw new Error(`refusing ${why}: avd ${shown}`);
}

export function guardUninstall(): void {
  assertDcPhone('uninstall');
  adbOnTestPhone(['uninstall', APP], 60_000);
}

function a0(phone: Emu, ctx: RunCtx): void {
  const root = adbOnTestPhone(['root'], 60_000);
  if (root.code !== 0) throw new Error('adb root was refused');
  adbOnTestPhone(['wait-for-device'], 60_000);
  guardUninstall();
  const installed = ctx.install();
  ctx.save('a0-install.txt', installed);
  if (!/Installed .+ over what was there/.test(installed)) throw new Error('the release APK did not install');
  assertDcPhone('clear the screen lock');
  phone.shell('locksettings clear --old 1111');
  const pid = phone.shell(`pidof ${APP}`).out.trim();
  if (pid !== '') throw new Error('the app was already running before launch');
  const notification = phone.shell('dumpsys notification --noredact').out;
  const alarm = phone.shell('dumpsys alarm').out;
  const recents = phone.shell('dumpsys activity recents').out;
  const unix = phone.shell('cat /proc/net/unix').out;
  ctx.save('notification.txt', notification);
  ctx.save('alarm.txt', alarm);
  ctx.save('recents.txt', recents);
  ctx.save('unix.txt', unix);
  const titleTokens = [...new Set([...notification.matchAll(/android\.title=(\S+)/g)].map(m => m[1] ?? ''))];
  const windowKeys = [...new Set([...alarm.matchAll(/\b(window\w*)=/g)].map(m => m[1] ?? ''))];
  ctx.note(`A0 dump shapes: title ${titleTokens.join('|') || 'none'}, alarm ${windowKeys.join('|') || 'none'}, recents task ${/Task\{/.test(recents)}, unix webview ${devtoolsSocket(unix)}`);
  if (titleTokens.length > 0 && !titleTokens.includes('String')) throw new Error(`notification titles are ${titleTokens.join('|')}, not String`);
  if (/Alarm\{/.test(alarm) && !windowKeys.includes('window')) throw new Error(`alarms mark exactness with ${windowKeys.join('|') || 'nothing'}, not window`);
}

function a1(phone: Emu, ctx: RunCtx): void {
  pushSeed(ctx, 'dc-seed.dcbak');
  launch(phone, true);
  if (!phone.waitFor(words('Daily Commit'), 60_000)) throw new Error('the welcome screen did not draw');
  const welcome = grab(phone, ctx, 'a1-welcome.xml');
  const wordy = welcome.filter(n => n.text !== '' || n.desc !== '').length;
  ctx.note(`A1 accessibility nodes ${welcome.length}, with words ${wordy}`);
  restoreSeed(phone, ctx, 'dc-seed.dcbak', true);
  openSettings(phone, ctx);
  scrollTo(phone, has('This phone has no screen lock'));
  const before = phone.dump();
  ctx.save('a1-privacy.xml', phone.lastXml());
  if (!seen(before, has('This phone has no screen lock'))) throw new Error('the no-lock words were not on screen');
  const row = find(before, has('This phone has no screen lock'));
  if (row) {
    const [x, y] = centre(row);
    phone.shell(`input tap ${x} ${y}`);
  }
  pause(800);
  const after = phone.dump();
  if (!seen(after, has('This phone has no screen lock'))) throw new Error('tapping the no-lock row left that screen');
  if (seen(after, has('Android asks twice'))) throw new Error('the no-lock row started phone-lock setup');
  ctx.note('A1 info() reached the screen: the no-lock words are drawn only when screenLock is false');
}

function a2(phone: Emu, ctx: RunCtx): void {
  launch(phone, true);
  pause(800);
  const windows = phone.shell('dumpsys window windows').out;
  ctx.save('a2-windows.txt', windows);
  if (!windowIsSecure(windows)) throw new Error('the window is not secure');
  const raw = phone.execOut(['screencap']);
  ctx.save('a2-screencap.raw', raw);
  const captured = secureCapture(raw);
  if (captured === 'shown') throw new Error('the screencap was not black');
  if (captured === 'bars') throw new Platform('the app rows of the screencap are black; the system bars are not');
}

function a3(phone: Emu, ctx: RunCtx): void {
  phone.key('KEYCODE_HOME');
  pause(1000);
  const recents = phone.shell('dumpsys activity recents').out;
  ctx.save('a3-recents.txt', recents);
  const id = ourTaskId(recents);
  if (id === undefined) throw new Error('our task was not in recents');
  const ls = phone.shell('ls -l /data/system_ce/0/snapshots/').out;
  ctx.save('a3-snapshots.txt', ls);
  phone.key('KEYCODE_APP_SWITCH');
  pause(1500);
  ctx.save('a3-overview.raw', phone.execOut(['screencap']));
  phone.key('KEYCODE_BACK');
  const kept = recentsPicture(ls, id);
  if (kept !== undefined) throw new Error(kept);
  ctx.note(`A3 snapshot store has no ${id}.jpg`);
}

function a4(phone: Emu, ctx: RunCtx): void {
  launch(phone, true);
  pause(800);
  ensureOpen(phone, ctx);
  if (!showing(phone, words('Walk'))) {
    if (!phone.waitFor(words('Today'), 8_000)) {
      ctx.save('a4-not-today.xml', phone.lastXml());
      throw new Error('Today was not on screen');
    }
    phone.tap(words('Today'), 15_000);
  }
  phone.key('KEYCODE_HOME');
  pause(500);
  launch(phone, false);
  const immediate = grab(phone, ctx, 'a4-immediate.xml');
  pause(2000);
  const second = grab(phone, ctx, 'a4-after-2s.xml');
  if (habitShown(immediate) || habitShown(second)) throw new Error('the habit name was on screen after returning');
  let drawn = second;
  if (!lockShown(drawn)) {
    const until = Date.now() + 15_000;
    while (Date.now() < until && !lockShown(drawn)) {
      pause(1000);
      drawn = grab(phone, ctx, 'a4-later.xml');
      if (habitShown(drawn)) throw new Error('the habit name was on screen after returning');
    }
    ctx.note('A4 the lock words were not in the 2s dump; the cover was still up and a later dump had them');
  }
  if (!lockShown(drawn)) throw new Error('the lock screen did not appear after returning');
  if (!seen(drawn, words('Use your passphrase'))) {
    ctx.note('A4 passphrase is the only way, so the screen says Locked and Passphrase, not Use your passphrase');
  }
}

async function devtoolsReply(pid: string): Promise<string> {
  const port = '18765';
  adbOnTestPhone(['forward', `tcp:${port}`, `localabstract:webview_devtools_remote_${pid}`], 20_000);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(5_000) });
    return (await res.text()).slice(0, 4_000);
  } catch (err) {
    return err instanceof Error ? err.name : 'no answer';
  } finally {
    adbOnTestPhone(['forward', '--remove', `tcp:${port}`]);
  }
}

async function a5(phone: Emu, ctx: RunCtx): Promise<void> {
  const runAs = phone.shell(`run-as ${APP} ls`);
  ctx.save('a5-run-as.txt', runAs.out);
  if (!/not debuggable/i.test(runAs.out)) throw new Error('run-as did not refuse');
  launch(phone, true);
  const pid = phone.shell(`pidof ${APP}`).out.trim().split(/\s+/).find(p => /^\d+$/.test(p)) ?? '';
  const unix = phone.shell('cat /proc/net/unix').out;
  ctx.save('a5-unix.txt', unix);
  const sockets = [...unix.matchAll(/@webview_devtools_remote_(\d+)/g)].map(m => m[1] ?? '');
  if (pid === '' || !sockets.includes(pid)) {
    if (devtoolsSocket(unix)) throw new Error(`a webview devtools socket belongs to pid ${sockets.join(',') || 'unknown'}, not the app (${pid || 'not running'})`);
    return;
  }
  const reply = await devtoolsReply(pid);
  const image = phone.shell('getprop ro.build.type').out.trim();
  const serves = /"webSocketDebuggerUrl"/.test(reply) || /Daily Commit/.test(reply);
  const verdict = devtoolsOnImage(image, serves);
  ctx.note(`A5 image ${image || 'unreadable'}, devtools reply ${reply.length} chars, ${verdict}`);
  if (verdict === 'open') throw new Error('a webview devtools socket is open');
  if (verdict === 'debug-image') throw new Platform('a debug Android image keeps the devtools socket open; setWebContentsDebuggingEnabled(false) does not turn it off');
  throw new Error('the devtools socket name exists and does not serve a page');
}

function a6(phone: Emu, ctx: RunCtx): void {
  openRestore(phone, ctx);
  phone.tap(has('Choose a file'), 20_000);
  pause(20_000);
  phone.key('KEYCODE_BACK');
  if (!phone.waitFor(has('Restore from a backup'), 20_000)) throw new Error('a hand-off under five minutes left the restore screen');
  if (locked(phone)) throw new Error('a hand-off under five minutes locked');
  phone.tap(has('Choose a file'), 20_000);
  pause(5 * 60_000 + 15_000);
  phone.key('KEYCODE_BACK');
  if (!phone.waitFor(words('Locked'), 25_000) && !phone.waitFor(words('Passphrase'), 8_000)) {
    throw new Error('a hand-off past five minutes did not lock');
  }
}

function a7(phone: Emu, ctx: RunCtx): void {
  ensureOpen(phone, ctx);
  openRestore(phone, ctx);
  phone.tap(has('Choose a file'), 20_000);
  pause(1500);
  phone.key('KEYCODE_SLEEP');
  pause(3000);
  wakeSwipe(phone);
  phone.key('KEYCODE_BACK');
  if (!phone.waitFor(words('Locked'), 25_000) && !phone.waitFor(words('Passphrase'), 8_000)) {
    throw new Error('the screen going off during a hand-off did not lock');
  }
  ctx.note('A7 SCREEN_OFF during the picker ended on the lock screen');
}

function appPid(phone: Emu): string {
  return phone.shell(`pidof ${APP}`).out.trim().split(/\s+/).find(p => /^\d+$/.test(p)) ?? '';
}

function pickerWords(nodes: readonly UiNode[]): boolean {
  return seen(nodes, has('Show roots')) || seen(nodes, has('Downloads')) || seen(nodes, words('Recent'));
}

function waitPicker(phone: Emu): void {
  const until = Date.now() + 20_000;
  let nodes = phone.dump();
  while (Date.now() < until) {
    nodes = phone.dump();
    if (!seen(nodes, has('Restore from a backup')) && pickerWords(nodes)) return;
    pause(400);
  }
  const labels = nodeLabels(nodes).map(t => t.replace(/\s+/g, ' ').trim()).filter(t => t.length > 0 && t.length < 60).slice(0, 8);
  throw new Error(`the picker did not open (${labels.join(' | ') || 'no words'})`);
}

function killApp(phone: Emu): void {
  phone.shell(`am kill ${APP}`);
  pause(800);
  let pid = appPid(phone);
  if (pid === '') return;
  const killed = phone.shell(`kill -9 ${pid}`);
  pause(400);
  pid = appPid(phone);
  if (pid !== '') {
    const why = killed.out.replace(/\s+/g, ' ').trim().slice(0, 140) || `code ${killed.code}`;
    throw new Error(`the app stayed up after kill -9 (${why})`);
  }
}

function saveScreenUp(nodes: readonly UiNode[]): boolean {
  const ours = seen(nodes, has('Export a copy')) || seen(nodes, has('Restore from a backup'));
  return !ours && (seen(nodes, words('Save')) || pickerWords(nodes));
}

function waitSaveScreen(phone: Emu): void {
  const until = Date.now() + 20_000;
  let nodes = phone.dump();
  while (Date.now() < until) {
    nodes = phone.dump();
    if (saveScreenUp(nodes)) return;
    pause(400);
  }
  const labels = nodeLabels(nodes).map(t => t.replace(/\s+/g, ' ').trim()).filter(t => t.length > 0 && t.length < 60).slice(0, 8);
  throw new Error(`the save screen did not open (${labels.join(' | ') || 'no words'})`);
}

function cameBackLocked(phone: Emu, ctx: RunCtx, dumpName: string): void {
  const until = Date.now() + 40_000;
  while (Date.now() < until) {
    if (locked(phone) || showing(phone, words('Passphrase'))) return;
    pause(700);
  }
  ctx.save(dumpName, phone.lastXml());
  const front = resumedActivity(phone.shell('dumpsys activity activities').out) ?? 'none';
  const labels = nodeLabels(phone.dump()).map(t => t.replace(/\s+/g, ' ').trim()).filter(t => t.length > 0 && t.length < 60).slice(0, 8);
  throw new Error(`the app did not come back locked (front ${front}; ${labels.join(' | ') || 'no words'})`);
}

function a8(phone: Emu, ctx: RunCtx): void {
  ensureOpen(phone, ctx);
  openRestore(phone, ctx);
  phone.tap(has('Choose a file'), 20_000);
  waitPicker(phone);
  killApp(phone);
  ctx.note('A8 killed the app while the picker was open');
  phone.key('KEYCODE_BACK');
  cameBackLocked(phone, ctx, 'a8-back.xml');
  unlock(phone, ctx.seed.passphrase);
  if (!phone.waitFor(has("The restore didn't finish"), 20_000)) throw new Error('the restore note was not on Today');
  const note = phone.dump();
  if (!seen(note, words('Leave it')) || !seen(note, words('Restore again'))) throw new Error('the restore note was missing an action');
  phone.key('KEYCODE_HOME');
  pause(500);
  launch(phone, true);
  unlock(phone, ctx.seed.passphrase);
  pause(1500);
  if (showing(phone, has("The restore didn't finish"))) throw new Error('the restore note showed again on the next unlock');
}

function a9(phone: Emu, ctx: RunCtx): void {
  phone.shell('settings put global always_finish_activities 1');
  ensureOpen(phone, ctx);
  openSettings(phone, ctx);
  scrollTo(phone, has('Export a copy'));
  phone.tap(has('Export a copy'), 20_000);
  waitSaveScreen(phone);
  const flag = phone.shell('settings get global always_finish_activities').out.trim();
  const acts = phone.shell('dumpsys activity activities').out;
  ctx.save('a9-activities.txt', acts);
  const ours = acts.split(/\r?\n/).filter(l => l.includes('app.dailycommit') || l.includes('alwaysFinish')).slice(0, 6);
  ctx.note(`A9 always_finish_activities=${flag}; ${ours.map(l => l.trim()).join(' || ') || 'no activity line'}`);
  phone.key('KEYCODE_BACK');
  cameBackLocked(phone, ctx, 'a9-back.xml');
  phone.shell('settings put global always_finish_activities 0');
  unlock(phone, ctx.seed.passphrase);
  if (!phone.waitFor(has("The export didn't finish"), 20_000)) throw new Error('the export note was not shown');
  const names = phone.shell('ls /sdcard/Download').out.split(/\r?\n/);
  if (names.some(n => /backup-.*\.dcbak/.test(n))) throw new Error('an empty backup was left in Download');
}

export function focusDiaryPage(phone: Emu): void {
  if (!phone.waitFor(words('Earlier'), 15_000) && !phone.waitFor(words('Not yet'), 4_000)) {
    throw new Error('the diary did not open');
  }
  // This WebView often leaves the empty page's aria-label out of the tree. The field sits under the date row.
  if (phone.waitFor(words('Diary page'), 2_000)) {
    phone.tap(words('Diary page'), 10_000);
    return;
  }
  const anchor = find(phone.dump(), words('Earlier')) ?? find(phone.dump(), words('Not yet'));
  if (!anchor || !onScreen(anchor)) throw new Error('the diary page was not on screen');
  const [w, h] = screenOf(phone);
  const y = Math.min(h - 80, anchor.bounds[3] + 160);
  phone.shell(`input tap ${Math.floor(w / 2)} ${y}`);
  pause(400);
}

function a10(phone: Emu, ctx: RunCtx): void {
  ensureOpen(phone, ctx);
  dismissOffer(phone);
  phone.tap(words('Diary'), 20_000);
  focusDiaryPage(phone);
  phone.type('CANARY-TYPED-R36');
  const before = grab(phone, ctx, 'a10-typed.xml');
  const landed = seen(before, has('CANARY-TYPED-R36'));
  if (!landed) throw new Platform('adb input text did not reach the diary page');
  phone.key('KEYCODE_SLEEP');
  pause(1000);
  wakeSwipe(phone);
  pause(1200);
  // After the screen comes back the WebView's tree is often only the brand until something is tapped.
  poke(phone);
  let woke = screenAfterWake(phone);
  if (woke === 'blank') {
    // The secure window's tree drops to the brand after the display turns off. Bringing the activity forward fills it in again.
    launch(phone, true);
    woke = screenAfterWake(phone);
  }
  if (woke === 'locked') {
    unlock(phone, ctx.seed.passphrase);
    dismissOffer(phone);
    phone.tap(words('Diary'), 20_000);
  }
  const after = grab(phone, ctx, 'a10-after.xml');
  if (!seen(after, has('CANARY-TYPED-R36'))) {
    const labels = nodeLabels(after).map(t => t.replace(/\s+/g, ' ').trim()).filter(t => t.length > 0 && t.length < 60).slice(0, 8);
    throw new Error(`the diary lost the words typed as the screen went off (${labels.join(' | ') || 'no words'})`);
  }
}

function poke(phone: Emu): void {
  const [w, h] = screenOf(phone);
  phone.shell(`input tap ${Math.floor(w / 2)} ${Math.floor(h * 0.25)}`);
  pause(600);
}

function screenAfterWake(phone: Emu): 'open' | 'locked' | 'blank' {
  const until = Date.now() + 20_000;
  let nodes = phone.dump();
  while (Date.now() < until) {
    if (seen(nodes, has('CANARY-TYPED-R36')) || seen(nodes, words('Earlier')) || seen(nodes, words('Diary page'))) return 'open';
    if (seen(nodes, words('Locked')) || (seen(nodes, words('Passphrase')) && seen(nodes, words('Open')))) return 'locked';
    pause(700);
    nodes = phone.dump();
  }
  return 'blank';
}

function a11(phone: Emu, ctx: RunCtx): void {
  // The earlier fill of /data/local/tmp landed on the shared emulated volume and took the UI down. Free it first.
  assertDcPhone('remove the fill file');
  phone.shell('rm -f /data/local/tmp/dc-fill /data/user/0/app.dailycommit/dc-fill');
  phone.shell('sync');
  const all = phone.shell('df').out;
  const app = phone.shell('df /data/user/0/app.dailycommit').out;
  ctx.save('a11-df-all.txt', all);
  ctx.save('a11-df-app.txt', app);
  if (/emulated|pass_through|\/obb/.test(app)) {
    ctx.note('A11 the app directory is on the shared volume');
    throw new Platform('filling the shared volume until a write is refused takes down the system UI, while df still shows about 16 MB free');
  }
  const before = app;
  ctx.save('a11-df.txt', before);
  const fillKb = availKb(before) - 2 * 1024;
  if (fillKb < 1024) throw new Error('not enough free space to leave 2 MB');
  const fall = adbOnTestPhone(['shell', `fallocate -l ${fillKb * 1024} /data/user/0/app.dailycommit/dc-fill`], 120_000);
  let left = availKb(phone.shell('df /data/user/0/app.dailycommit').out);
  ctx.save('a11-fallocate.txt', fall.out);
  ctx.note(`A11 fallocate code ${fall.code}, ${left} KB left`);
  // This image still reports about 16 MB free after the write is refused. No space left is full enough.
  const refused = (out: string): boolean => /No space left/i.test(out);
  if (!refused(fall.out) && (fall.code !== 0 || left > 8 * 1024)) {
    phone.shell('rm -f /data/user/0/app.dailycommit/dc-fill');
    const wrote = adbOnTestPhone(['shell', `dd if=/dev/zero of=/data/user/0/app.dailycommit/dc-fill bs=1048576 count=${Math.floor(fillKb / 1024)}`], 10 * 60_000);
    left = availKb(phone.shell('df /data/user/0/app.dailycommit').out);
    ctx.save('a11-dd.txt', wrote.out);
    ctx.note(`A11 dd code ${wrote.code}, ${left} KB left`);
    if (!refused(wrote.out) && left > 8 * 1024) throw new Error(`the fill did not fill the disk (${left} KB left)`);
  }
  ensureOpen(phone, ctx);
  phone.tap(words('Today'), 15_000);
  scrollTo(phone, words('Walk'));
  phone.tap(words('Walk'), 15_000);
  if (!phone.waitFor(words('Did it'), 4_000)) phone.tap(words('Walk'), 10_000);
  scrollTo(phone, words('Did it'));
  phone.tap(words('Did it'), 15_000);
  const full = phone.waitFor(has('Not saved yet'), 15_000) || phone.waitFor(has("That couldn't be saved"), 8_000) || phone.waitFor(has('The phone is out of space'), 5_000);
  ctx.save('a11-full.xml', phone.lastXml());
  if (!full) throw new Error('a full phone did not say the write was not saved');
  phone.shell('rm -f /data/user/0/app.dailycommit/dc-fill');
  pause(500);
  if (!showing(phone, words('Did it'))) {
    phone.tap(words('Walk'), 15_000);
  }
  phone.tap(words('Did it'), 15_000);
  const until = Date.now() + 20_000;
  let cleared = false;
  while (Date.now() < until) {
    const nodes = phone.dump();
    if (!seen(nodes, has('Not saved yet')) && !seen(nodes, has("That couldn't be saved")) && !seen(nodes, has('The phone is out of space'))) {
      cleared = true;
      break;
    }
    pause(800);
  }
  if (!cleared) throw new Error('the write still said it was not saved after space was freed');
}

function a12(phone: Emu, ctx: RunCtx): void {
  enrolPhoneLock(phone, ctx);
  phone.key('KEYCODE_HOME');
  pause(500);
  launch(phone, true);
  if (!phone.waitFor(has("Use your phone's PIN or pattern"), 30_000)) throw new Error('the lock screen did not offer the phone lock');
  phone.tap(has("Use your phone's PIN or pattern"), 15_000);
  confirmPin(phone, ctx);
  if (!waitPastLock(phone, 20_000)) {
    throw new Platform('the lock screen phone-PIN control did not open a credential activity the driver can type into');
  }
}

function brief(nodes: readonly UiNode[]): string {
  return nodeLabels(nodes).map(t => t.replace(/\s+/g, ' ').trim()).filter(t => t.length > 0 && t.length < 60).slice(0, 8).join(' | ') || 'no words';
}

function waitPastLock(phone: Emu, timeoutMs: number): boolean {
  const until = Date.now() + timeoutMs;
  do {
    if (pastLock(phone.dump())) return true;
    pause(700);
  } while (Date.now() < until);
  return false;
}

function recordIsOpen(phone: Emu): boolean {
  return pastLock(phone.dump());
}

/** The code pad. Today also has a node whose text is "1" (the day), so the pad needs the lock and two digits. */
export function codePad(phone: Emu): boolean {
  return showing(phone, words('LOCKED')) && showing(phone, words('1')) && showing(phone, words('2')) && !showing(phone, words('Passphrase'));
}

/** Touches only once the credential activity is in front. One early touch misses the prompt. */
function touchWhilePrompt(phone: Emu, ctx: RunCtx, name: string): boolean {
  const until = Date.now() + 22_000;
  let touches = 0;
  while (Date.now() < until) {
    const step = fingerStep(recordIsOpen(phone), credentialInFront(phone), touches);
    if (step === 'done') return true;
    if (step === 'touch') {
      phone.finger();
      touches++;
      pause(700);
      continue;
    }
    pause(400);
  }
  ctx.save(`${name}.xml`, phone.lastXml());
  ctx.note(`${name}: ${touches} touches, prompt ${credentialInFront(phone) ? 'up' : 'down'}: ${brief(phone.dump())}`);
  return false;
}

function leavePrompt(phone: Emu): void {
  if (!credentialInFront(phone)) return;
  phone.key('KEYCODE_BACK');
  pause(800);
}

/** A previous run's cleanup clears the PIN. verify can report success when the lock is already gone, so a disabled lock is set again. */
function ensurePin(phone: Emu, ctx: RunCtx): void {
  const disabled = phone.shell('locksettings get-disabled').out.trim().split('\n')[0] ?? '';
  const verified = phone.shell(`locksettings verify --old ${PIN}`);
  ctx.note(`A13 lock disabled ${disabled} verify ${verified.code}`);
  if (verified.code === 0 && !/true/i.test(disabled)) return;
  const set = phone.shell(`locksettings set-pin ${PIN}`);
  ctx.note(`A13 screen lock set code ${set.code}`);
  if (set.code !== 0) throw new Platform('the screen lock could not be set again after the previous run cleared it');
}

function enrolDeviceFinger(phone: Emu, ctx: RunCtx, another: boolean): boolean {
  const started = phone.shell('am start -a android.settings.FINGERPRINT_ENROLL');
  if (started.code !== 0) throw new Platform('fingerprint enrolment activity did not start');
  const until = Date.now() + 90_000;
  let touches = 0;
  let added = false;
  // A second enrolment resumes on "Fingerprint added". Wait until that screen is gone, then for a new one.
  let leftDone = !another;
  let lockAsks = 0;
  let restarts = 0;
  while (Date.now() < until) {
    const nodes = phone.dump();
    const focus = phone.shell('dumpsys window').out.split('\n').find(line => line.includes('mCurrentFocus')) ?? '';
    // Enrolment can lose the foreground to our own lock screen. Bring it back. Any other window is the wizard.
    if (focus.includes(`${APP}/`) || (seen(nodes, words('LOCKED')) && seen(nodes, words('1')))) {
      if (restarts >= 4) break;
      restarts++;
      phone.shell('am start -a android.settings.FINGERPRINT_ENROLL');
      pause(1200);
      continue;
    }
    const doneScreen = seen(nodes, has('Fingerprint added'));
    if (!leftDone && findClickable(nodes, words('ADD ANOTHER'))) {
      tapNode(phone, nodes, words('ADD ANOTHER'));
      pause(600);
      continue;
    }
    if (!leftDone && !doneScreen) leftDone = true;
    if (leftDone && doneScreen) { added = true; break; }
    if (seen(nodes, has("isn't available")) || seen(nodes, has('not available'))) break;
    // This screen is Choose Lock, not the sensor. NEXT starts a pattern we cannot draw. Set the PIN and open enrolment again.
    if (seen(nodes, has('set pattern')) || seen(nodes, has('set a PIN')) || seen(nodes, has('set a password'))) {
      if (lockAsks >= 2) break;
      lockAsks++;
      const set = phone.shell(`locksettings set-pin ${PIN}`);
      ctx.note(`A13 fingerprint setup asked for a screen lock (set-pin ${set.code})`);
      phone.shell('am start -a android.settings.FINGERPRINT_ENROLL');
      pause(1000);
      continue;
    }
    if (credentialInFront(phone)) { confirmPin(phone, ctx); continue; }
    const next = ['Next', 'More', 'I agree', 'Agree', 'Done', 'Start', 'Confirm']
      .map(label => findClickable(nodes, words(label))).find(n => n !== undefined);
    if (next && !(another && !leftDone && (next.text.toLowerCase() === 'done' || next.desc.toLowerCase() === 'done'))) {
      const [x, y] = centre(next);
      phone.shell(`input tap ${x} ${y}`);
      pause(500);
      continue;
    }
    if (touches < 25) { phone.finger(); touches++; pause(400); continue; }
    break;
  }
  ctx.save(another ? 'a13-second.xml' : 'a13-enrol.xml', phone.lastXml());
  ctx.note(`A13 ${another ? 'second ' : ''}fingerprint enrolment ${added ? 'added' : 'not added'} after ${touches} touches`);
  return added;
}

function answerPrompts(phone: Emu, want: number): number {
  let prompts = 0;
  let open = false;
  const until = Date.now() + 45_000;
  while (Date.now() < until && prompts < want) {
    if (credentialInFront(phone)) {
      if (!open) { open = true; prompts++; }
      phone.finger();
      pause(800);
    } else if (open) {
      open = false;
      pause(500);
    } else pause(400);
  }
  return prompts;
}

function a13(phone: Emu, ctx: RunCtx): void {
  ensurePin(phone, ctx);
  if (!enrolDeviceFinger(phone, ctx, false)) throw new Platform('the emulator did not enrol a fingerprint');
  launch(phone, true);
  dismissKeyguard(phone);
  let phoneLock = false;
  if (phone.waitFor(has('Unlock with fingerprint'), 20_000)) {
    phone.tap(words('Unlock with fingerprint'), 15_000);
    phoneLock = touchWhilePrompt(phone, ctx, 'a13-phone-lock');
  } else {
    ctx.save('a13-nolock.xml', phone.lastXml());
    ctx.note(`A13 the lock screen did not offer Unlock with fingerprint: ${brief(phone.dump())}`);
  }
  if (!phoneLock) leavePrompt(phone);
  const codeAlready = codePad(phone);
  if (codeAlready) ctx.note('A13 the separate code is already set');
  openSettings(phone, ctx);
  if (codeAlready) {
    scrollTo(phone, has('Fingerprint opens it too'));
    phone.tap(has('Fingerprint opens it too'), 15_000);
  } else {
  scrollTo(phone, has('A separate code'));
  phone.tap(has('A separate code'), 15_000);
  try {
    focusSecret(phone, 'Passphrase');
  } catch {
    throw new Platform('own-code setup did not ask for the passphrase');
  }
  phone.type(ctx.seed.passphrase);
  phone.tap(words('Continue'), 15_000);
  enterDigits(phone, '111111', 'Next');
  enterDigits(phone, '111111', 'Set the code');
  if (!phone.waitFor(words('Done'), 25_000)) throw new Error('the code was not set');
  phone.tap(words('Done'), 15_000);
  scrollTo(phone, has('Fingerprint opens it too'));
  phone.tap(has('Fingerprint opens it too'), 15_000);
  }
  if (!phone.waitFor(has('Letting the fingerprint'), 12_000) && !phone.waitFor(has('Android asks twice'), 8_000)) {
    ctx.save('a13-finger-setup.xml', phone.lastXml());
    throw new Platform(`fingerprint setup did not ask for the passphrase (${brief(phone.dump())})`);
  }
  focusSecret(phone, 'Passphrase');
  phone.type(ctx.seed.passphrase);
  phone.tap(words('Continue'), 15_000);
  const prompts = answerPrompts(phone, 2);
  ctx.note(`A13 fingerprint prompts touched: ${prompts}`);
  if (prompts < 1) {
    ctx.save('a13-prompts.xml', phone.lastXml());
    throw new Platform(`the fingerprint prompt did not appear (${brief(phone.dump())})`);
  }
  phone.key('KEYCODE_HOME');
  pause(500);
  launch(phone, true);
  dismissKeyguard(phone);
  if (!phone.waitFor(words('Use fingerprint'), 20_000)) {
    ctx.save('a13-pad.xml', phone.lastXml());
    throw new Platform(`the code pad did not offer the fingerprint key (${brief(phone.dump())})`);
  }
  phone.tap(words('Use fingerprint'), 10_000);
  if (!touchWhilePrompt(phone, ctx, 'a13-code-finger')) throw new Platform('a fingerprint touch did not open the own-code lock');
  if (!enrolDeviceFinger(phone, ctx, true)) throw new Platform('a second fingerprint was not enrolled');
  launch(phone, true);
  dismissKeyguard(phone);
  if (phone.waitFor(words('Use fingerprint'), 20_000)) {
    phone.tap(words('Use fingerprint'), 10_000);
    touchWhilePrompt(phone, ctx, 'a13-after-new');
  }
  if (!phone.waitFor(has('A new fingerprint was added'), 25_000)) {
    ctx.save('a13-note.xml', phone.lastXml());
    throw new Platform(`a second fingerprint did not produce the new-fingerprint note (${brief(phone.dump())})`);
  }
  ctx.note('A13 the new-fingerprint note was shown');
  if (showing(phone, words('Passphrase'))) unlock(phone, ctx.seed.passphrase);
  else enterDigits(phone, '111111', 'Open');
  if (!showing(phone, words('Walk')) && !phone.waitFor(words('Walk'), 30_000)) throw new Error('the code did not open after the new fingerprint');
  if (!phoneLock) throw new Platform('the phone-lock prompt did not open on a fingerprint touch; the own-code fingerprint and the new-fingerprint note did');
}

export function enterDigits(phone: Emu, digits: string, ok: string): void {
  if (!phone.waitFor(words('1'), 20_000)) throw new Error('the code pad was not on screen');
  for (const d of digits) phone.tap(words(d), 8_000);
  phone.tap(words(ok), 15_000);
}

function a14(phone: Emu, ctx: RunCtx): void {
  launch(phone, true);
  dismissKeyguard(phone);
  const showed = phone.waitFor(has("Use your phone's PIN or pattern"), 12_000) || phone.waitFor(has('Unlock with fingerprint'), 4_000);
  if (!showed) {
    ctx.note(`A14 switches back to the phone lock before clearing it (${brief(phone.dump())})`);
    if (codePad(phone)) enterDigits(phone, '111111', 'Open');
    else {
      if (showing(phone, words('Use your passphrase'))) phone.tap(words('Use your passphrase'), 10_000);
      if (showing(phone, words('Passphrase')) || locked(phone)) unlock(phone, ctx.seed.passphrase);
    }
    enrolPhoneLock(phone, ctx);
  }
  assertDcPhone('clear the screen lock');
  const cleared = phone.shell(`locksettings clear --old ${PIN}`);
  ctx.note(`A14 locksettings clear code ${cleared.code}`);
  phone.key('KEYCODE_HOME');
  pause(500);
  launch(phone, true);
  dismissKeyguard(phone);
  const way = find(phone.dump(), has("Use your phone's PIN or pattern")) ?? find(phone.dump(), words('Unlock with fingerprint'));
  if (way) {
    const [x, y] = centre(way);
    phone.shell(`input tap ${x} ${y}`);
    pause(1500);
  }
  if (!phone.waitFor(has('That way of opening is switched off now'), 25_000)) {
    ctx.save('a14-after.xml', phone.lastXml());
    throw new Error(`removing the screen lock did not switch that way off (${brief(phone.dump())})`);
  }
  if (!recordOpened(phone.dump())) unlock(phone, ctx.seed.passphrase);
  openSettings(phone, ctx);
  scrollTo(phone, has('This phone has no screen lock'));
  if (!showing(phone, has('This phone has no screen lock'))) throw new Error('Settings did not return to the no-lock words');
}

/** One dump. The lock screen says Locked, or it is the passphrase field or the code pad. */
function lockState(phone: Emu): 'measure' | 'lock' | 'wait' {
  const nodes = phone.dump();
  const open = recordOpened(nodes);
  const onLock = seen(nodes, words('Locked'))
    || seen(nodes, words('Use your passphrase'))
    || (seen(nodes, words('Passphrase')) && seen(nodes, words('Open')) && !seen(nodes, has('Restore from a backup')));
  return timingStep(open, onLock);
}

function prepareUnlock(phone: Emu, ctx: RunCtx): void {
  dismissKeyguard(phone);
  if (showing(phone, words('Restore it'))) openFoundCopy(phone, ctx);
}

/** Home locks when nothing is handed off. The screen going off locks even during a hand-off. */
function forceLock(phone: Emu): void {
  if (lockState(phone) === 'measure') return;
  phone.key('KEYCODE_HOME');
  pause(800);
  launch(phone, true);
  dismissKeyguard(phone);
  const until = Date.now() + 12_000;
  while (lockState(phone) !== 'measure' && Date.now() < until) pause(450);
  if (lockState(phone) === 'measure') return;
  phone.key('KEYCODE_SLEEP');
  pause(1500);
  wakeSwipe(phone);
  dismissKeyguard(phone);
  if (!appInFront(phone)) launch(phone, true);
  const slept = Date.now() + 15_000;
  while (lockState(phone) !== 'measure' && Date.now() < slept) pause(450);
  if (lockState(phone) !== 'measure') throw new Error(`the record did not lock (${brief(phone.dump())})`);
}

/** Open whatever lock is on screen. The code pad has no passphrase field. */
function openLock(phone: Emu, passphrase: string): void {
  if (codePad(phone)) {
    enterDigits(phone, '111111', 'Open');
    const until = Date.now() + 60_000;
    let nodes = phone.dump();
    while (!pastLock(nodes) && Date.now() < until) {
      pause(700);
      nodes = phone.dump();
    }
    if (!pastLock(nodes)) throw new Error(`the code did not open (${brief(nodes)})`);
    return;
  }
  unlock(phone, passphrase);
}

function readUnlockLines(phone: Emu): string[] {
  let lines: string[] = [];
  const until = Date.now() + 8_000;
  do {
    lines = logMessages(phone);
    if (lines.length > 0 && lines.every(l => /^unlock \d+ ms$/.test(l))) return lines;
    pause(400);
  } while (Date.now() < until);
  return lines;
}

function a15(phone: Emu, ctx: RunCtx): void {
  // The tag is read when the process starts, so the quiet pass starts with it off.
  phone.shell('setprop log.tag.DailyCommit ""');
  phone.shell('logcat -c');
  phone.shell(`am force-stop ${APP}`);
  pause(400);
  launch(phone, true);
  prepareUnlock(phone, ctx);
  if (lockState(phone) !== 'measure') forceLock(phone);
  phone.shell('logcat -c');
  openLock(phone, ctx.seed.passphrase);
  const quiet = logMessages(phone);
  ctx.save('a15-off.txt', quiet.join('\n'));
  if (quiet.length > 0) throw new Error(`timing was logged while off (${quiet.length} lines)`);
  const on = phone.shell('setprop log.tag.DailyCommit VERBOSE');
  if (on.code !== 0) throw new Error('the timing tag could not be switched on');
  phone.shell('sync');
  pause(800);
  phone.shell(`am force-stop ${APP}`);
  pause(400);
  launch(phone, true);
  prepareUnlock(phone, ctx);
  // A found-copy restore logs its own line. Drop that, then lock, then measure the unlock.
  phone.shell('logcat -c');
  if (showing(phone, words('Restore it'))) throw new Platform('a cold start offers the found copy, so there is no unlock timing to read');
  if (lockState(phone) !== 'measure') forceLock(phone);
  phone.shell('logcat -c');
  if (lockState(phone) !== 'measure') {
    ctx.save('a15-lock.xml', phone.lastXml());
    throw new Error(`the lock screen was not up for the timing sample (${brief(phone.dump())})`);
  }
  ctx.save('a15-lock.xml', phone.lastXml());
  ctx.note(`A15 sample: ${brief(phone.dump())}`);
  const tag = phone.shell('getprop log.tag.DailyCommit').out.trim();
  ctx.note(`A15 log tag ${tag || 'unset'}`);
  openLock(phone, ctx.seed.passphrase);
  const lines = readUnlockLines(phone);
  phone.shell('setprop log.tag.DailyCommit ""');
  ctx.save('a15-on.txt', lines.join('\n'));
  ctx.save('a15-after.xml', phone.lastXml());
  if (lines.length === 0 || lines.some(l => !/^unlock \d+ ms$/.test(l))) {
    throw new Error(`the timing lines were ${lines.length} and not only unlock timings (${lines.join(' ; ') || 'none'}; tag ${tag || 'unset'}; ${brief(phone.dump())})`);
  }
}

async function a16(phone: Emu, ctx: RunCtx): Promise<void> {
  // The offer is once per device, and the device table is not in a backup. A1's unlock already spent it.
  assertDcPhone('clear app data');
  const cleared = phone.shell(`pm clear ${APP}`);
  if (cleared.code !== 0) throw new Error('the app data could not be cleared');
  // Clear force-stops the process. A start in that same moment is stopped again and the launcher is what remains.
  pause(2000);
  launch(phone, true);
  const untilFront = Date.now() + 15_000;
  while (!appInFront(phone) && Date.now() < untilFront) pause(700);
  if (!appInFront(phone)) launch(phone, true);
  if (phone.waitFor(words('Start new instead'), 25_000)) phone.tap(words('Start new instead'), 10_000);
  if (!phone.waitFor(has('Restore from a backup instead'), 40_000)) {
    ctx.save('a16-welcome.xml', phone.lastXml());
    throw new Error(`the welcome screen did not offer restore (${brief(phone.dump())})`);
  }
  // The cues are six and eight minutes ahead of this moment, so the restore still finishes before them.
  await ctx.reseed(phone);
  pushSeed(ctx, 'dc-seed.dcbak');
  restoreSeed(phone, ctx, 'dc-seed.dcbak', true);
  if (!phone.waitFor(has('Let Daily Commit send reminders'), 30_000)) {
    ctx.save('a16-after.xml', phone.lastXml());
    throw new Error(`the reminder setup did not open (${brief(phone.dump())})`);
  }
  phone.tap(words('Continue'), 15_000);
  const allow = /^\s*allow\s*$/i;
  const resumed: string[] = [];
  let allowed = false;
  const until = Date.now() + 10_000;
  while (Date.now() < until) {
    const act = resumedActivity(phone.shell('dumpsys activity activities').out);
    if (act) resumed.push(act);
    if (!allowed && showing(phone, allow)) {
      phone.tap(allow, 8_000);
      allowed = true;
    }
    pause(400);
  }
  const distinct = [...new Set(resumed)];
  ctx.note(`A16 resumed: ${distinct.join(', ') || 'none'}`);
  if (distinct.some(a => a.startsWith('com.android.settings/'))) throw new Error('reminders opened the Android settings app');
  if (!allowed && phone.waitFor(allow, 8_000)) {
    phone.tap(allow, 8_000);
    allowed = true;
  }
  ctx.note(`A16 allow ${allowed ? 'tapped' : 'not seen'}; ${brief(phone.dump())}`);
  if (!allowed) ctx.save('a16-ask.xml', phone.lastXml());
  if (phone.waitFor(words('Done'), 15_000)) phone.tap(words('Done'), 10_000);
  let alarms = '';
  let ours = ourAlarms('');
  const alarmUntil = Date.now() + 12_000;
  do {
    alarms = phone.shell('dumpsys alarm').out;
    ours = ourAlarms(alarms);
    if (ours.length > 0) break;
    pause(1000);
  } while (Date.now() < alarmUntil);
  ctx.save('a16-alarm.txt', alarms);
  const exact = phone.shell('cmd appops get app.dailycommit SCHEDULE_EXACT_ALARM').out;
  ctx.save('a16-appops.txt', exact);
  const reason = /exactAllowReason=(\S+)/.exec(alarms)?.[1] ?? 'absent';
  const perm = phone.shell('dumpsys package app.dailycommit').out;
  const granted = /POST_NOTIFICATIONS: granted=\w+/.exec(perm)?.[0] ?? 'POST_NOTIFICATIONS line absent';
  ctx.note(`A16 alarms ${ours.length}, exact ${ours.filter(a => a.exact).length}, exactAllowReason ${reason}, ${granted}`);
  if (ours.length === 0) throw new Error(`no alarm was scheduled (${granted})`);
  if (ours.some(a => !a.exact)) throw new Error('an alarm was not exact');
  if (ours.length > 500) throw new Error(`alarm count ${ours.length} is past the limit`);
}

function a17(phone: Emu, ctx: RunCtx): void {
  phone.shell('cmd connectivity airplane-mode enable');
  phone.key('KEYCODE_HOME');
  pause(500);
  phone.shell(`am kill ${APP}`);
  phone.shell('dumpsys battery unplug');
  phone.key('KEYCODE_SLEEP');
  phone.shell('dumpsys deviceidle force-idle');
  const now = deviceSec(phone);
  const d = new Date(now * 1000);
  const target = Math.floor(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 0, ctx.cues.shown + 1, 5) / 1000);
  if (target > now) pause((target - now) * 1000);
  const shown = ctx.seed.canaries.shownCue;
  let dump = '';
  const stop = Date.now() + 120_000;
  let hit = false;
  while (Date.now() < stop) {
    dump = phone.shell('dumpsys notification --noredact').out;
    hit = ourNotifications(dump).some(n => n.title === 'Daily Commit' && n.text === shown);
    if (hit) break;
    pause(15_000);
  }
  ctx.save('a17-notification.txt', dump);
  if (!hit) throw new Error('the shown reminder was not posted');
  if (canaryHits(Buffer.from(dump), [ctx.seed.canaries.privateCue]).length > 0) {
    throw new Error('the private reminder text was in the notification dump');
  }
  const block = dump.split(/(?=NotificationRecord\()/).find(b => b.includes(shown));
  if (block && !/channel=default\b/.test(block)) throw new Error('the reminder was not on channel default');
  phone.shell('dumpsys deviceidle unforce');
  phone.shell('dumpsys battery reset');
  phone.shell('cmd connectivity airplane-mode disable');
  // The screen was turned off for Doze. The next check cannot read a sleeping display.
  phone.key('KEYCODE_WAKEUP');
  wakeSwipe(phone);
}

function a18(phone: Emu, ctx: RunCtx): void {
  // A run that continues from A17 finds the screen asleep. A fresh boot is already awake; waking twice is harmless.
  phone.shell('dumpsys deviceidle unforce');
  phone.shell('dumpsys battery reset');
  phone.key('KEYCODE_WAKEUP');
  wakeSwipe(phone);
  dismissKeyguard(phone);
  launch(phone, true);
  pause(1000);
  const offer = has("Use your phone's PIN or pattern");
  let enrolled = showing(phone, offer) || showing(phone, has('Unlock with fingerprint'));
  if (!enrolled) {
    ctx.note('A18 sets the PIN and the phone lock again, because the earlier check cleared both');
    if (locked(phone)) unlock(phone, ctx.seed.passphrase);
    try {
      enrolPhoneLock(phone, ctx);
      enrolled = true;
    } catch (err) {
      if (!(err instanceof Platform)) throw err;
      ctx.note(`A18 ${err.message}`);
    }
    phone.key('KEYCODE_HOME');
    launch(phone, true);
  }
  const installed = ctx.install();
  ctx.save('a18-install.txt', installed);
  if (!/Installed .+ over what was there/.test(installed)) throw new Error('the update did not install over what was there');
  launch(phone, true);
  dismissKeyguard(phone);
  if (enrolled) {
    if (!phone.waitFor(offer, 30_000) && !phone.waitFor(has('Unlock with fingerprint'), 6_000)) {
      throw new Error('the lock screen did not offer the phone lock after the update');
    }
    if (showing(phone, offer)) phone.tap(offer, 15_000);
    else phone.tap(has('Unlock with fingerprint'), 15_000);
    confirmPin(phone);
    if (!waitPastLock(phone, 60_000)) {
      ctx.save('a18-after-pin.xml', phone.lastXml());
      throw new Platform(`the update kept the phone-lock offer, and this image's credential prompt still has no field the driver can type (${brief(phone.dump())})`);
    }
    return;
  }
  // The prompt never saved the phone-lock way. The update can still be checked: the record must open.
  if (locked(phone) || showing(phone, words('Passphrase')) || codePad(phone)) openLock(phone, ctx.seed.passphrase);
  if (!waitPastLock(phone, 8_000)) {
    ctx.save('a18-after-install.xml', phone.lastXml());
    throw new Error(`the update did not keep the record (${brief(phone.dump())})`);
  }
  throw new Platform("the phone-lock way was not saved, because this image's credential prompt has no field the driver can type and the emulator finger does not dismiss the app prompt. The update installed over what was there and the passphrase still opens the record");
}
