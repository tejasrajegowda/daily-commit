// Task 9's P3–P8 on the owner's phone, driven by script. The owner does only what is the owner's: a fingerprint,
// the phone's own PIN, Android's file picker, and what only the owner's eyes can answer. Every read goes through
// the guard (guard.ts), so only Daily Commit's own words are ever seen, and only the plan's "Recorded"
// items are kept: numbers, yes/no, and the keyboard's name.
import { find, pause, type Emu, type UiNode } from '../drive.ts';
import { codePad, enterDigits, focusDiaryPage, focusSecret, launch, pastLock, scrollTo } from './a.ts';
import { NotInApp, type Front } from './guard.ts';
import { LONG_PASSPHRASE } from './long.ts';

/** The plan's test values (Task 9). All invented. */
export const CODE = '135790';
export const DIARY_WORDS = 'Vextromil is a test word';
export const SCREEN_OFF_WORDS = 'CANARY typed screen off';

export type Step = 'P3' | 'P4' | 'P5' | 'P6' | 'P7' | 'P8';
export const STEPS: readonly Step[] = ['P3', 'P4', 'P5', 'P6', 'P7', 'P8'];

/** The plan's Recorded items for P3–P8, in its order. Nothing else is recorded. */
export const ITEMS = [
  { key: 'P3.firstRun', label: 'first run finished' },
  { key: 'P3.storage', label: 'the phone agreed to keep the record safe (persisted storage)' },
  { key: 'P4.restored', label: 'restored' },
  { key: 'P4.stayedOpen', label: 'the app stayed open while the picker was up' },
  { key: 'P4.restoreMs', label: 'restore ms' },
  { key: 'P4.opening', label: '"Opening…" seen' },
  { key: 'P4.timingTag', label: 'the timing switch was accepted (setprop, D-5)' },
  { key: 'P5.phoneLockTwice', label: "Android asked twice at the phone's lock set-up, and the page said so first" },
  { key: 'P5.fingerSwitchTwice', label: 'Android asked twice at the fingerprint switch, and the page said so first' },
  { key: 'P5.fingerMs', label: 'unlock ms, fingerprint ×3' },
  { key: 'P5.pinMs', label: 'unlock ms, phone PIN ×2' },
  { key: 'P5.codeMs', label: 'unlock ms, own code ×3' },
  { key: 'P5.codeFingerMs', label: "unlock ms, own code's fingerprint ×1" },
  { key: 'P5.lookbackMs', label: 'Look back ms ×2' },
  { key: 'P5.opening', label: '"Opening…" on any unlock' },
  { key: 'P5.over10s', label: 'any unlock over 10 s' },
  { key: 'P6.screenshot', label: 'screenshot refused' },
  { key: 'P6.recents', label: "Recents' card shows nothing of the record" },
  { key: 'P6.blinkIcon', label: 'a blink of the record on return, from the icon' },
  { key: 'P6.blinkRecents', label: "a blink of the record on return, from Recents' card" },
  { key: 'P6.blinkScreen', label: 'a blink of the record on return, screen off and on' },
  { key: 'P7.keyboard', label: 'which keyboard' },
  { key: 'P7.diaryWord', label: 'the diary word learned' },
  { key: 'P7.codeGroup', label: "the recovery code's group learned" },
  { key: 'P8.kept', label: 'the words typed as the screen went off are there' },
] as const;
export type ItemKey = (typeof ITEMS)[number]['key'];

export type Answer = 'yes' | 'no' | 'not done';

/** What the owner does. Each prints one plain `OWNER:` line and waits, at most the run's owner wait. */
export interface Owner {
  /** Polls `done` until it holds or the wait runs out. */
  wait(what: string, done: () => boolean): boolean;
  /** Waits for the owner's yes or no to `key`, relayed into the run's answers file. */
  ask(key: ItemKey, question: string): Answer;
}

export interface PCtx {
  readonly phone: Emu;
  front(): Front;
  pushLong(): boolean;
  readonly owner: Owner;
  record(key: ItemKey, value: string): void;
  note(line: string): void;
  /** Whether this run switched the timing line on and restarted the app for it. */
  timingOn: boolean;
}

// ---------- pure readers (tested) ----------

/** The owner's answer to `key` in the answers file (`P6.screenshot=yes`); the last line for a key wins. */
export function answerOf(text: string, key: string): 'yes' | 'no' | undefined {
  let found: 'yes' | 'no' | undefined;
  for (const raw of text.split(/\r?\n/)) {
    const m = /^\s*([A-Za-z0-9.]+)\s*=\s*(yes|no|y|n)\s*$/i.exec(raw);
    if (m?.[1] !== key) continue;
    found = (m[2] ?? '').toLowerCase().startsWith('y') ? 'yes' : 'no';
  }
  return found;
}

export interface Timing { readonly at: string; readonly label: 'unlock' | 'lookback' | 'restore'; readonly ms: number }

/** The app's three timing lines in `logcat -v threadtime -s DailyCommit:V`. Any other line is dropped unread. */
export function timingsOf(logcat: string): Timing[] {
  const out: Timing[] = [];
  for (const line of logcat.split(/\r?\n/)) {
    const m = /^(\d\d-\d\d \d\d:\d\d:\d\d\.\d{3})\s.*\sDailyCommit\s*:\s*(unlock|lookback|restore) (\d+) ms\s*$/.exec(line);
    if (m?.[1] === undefined || m[2] === undefined || m[3] === undefined) continue;
    out.push({ at: m[1], label: m[2] as Timing['label'], ms: Number(m[3]) });
  }
  return out;
}

/** The timings after `mark` (a threadtime stamp; '' is the start of the log). */
export function timingsAfter(all: readonly Timing[], mark: string): Timing[] {
  return all.filter(t => t.at > mark);
}

/** The keyboard's name from `settings get secure default_input_method`. Only the name is kept. */
export function keyboardName(setting: string): string {
  const s = setting.trim().toLowerCase();
  if (s === '' || s === 'null') return 'not readable';
  if (s.includes('honeyboard') || s.includes('samsung')) return 'Samsung Keyboard';
  if (s.startsWith('com.google.android.inputmethod.latin')) return 'Gboard';
  if (s.includes('swiftkey')) return 'Microsoft SwiftKey';
  return 'other';
}

function rx(label: string, whole: boolean): RegExp {
  const body = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(whole ? `^${body}$` : body, 'i');
}
const words = (label: string) => rx(label, true);
const has = (label: string) => rx(label, false);
const seen = (nodes: readonly UiNode[], label: string | RegExp) => find(nodes, label) !== undefined;

/** The storage line's answer (C11): agreed, may clear, or not asked. Undefined when the line isn't on screen. */
export function storageAnswer(nodes: readonly UiNode[]): 'yes' | 'no' | 'not asked' | undefined {
  if (seen(nodes, has('agreed to keep it safe'))) return 'yes';
  if (seen(nodes, has('may clear it if space runs very low'))) return 'no';
  if (seen(nodes, has('Android may clear it only if'))) return 'not asked';
  return undefined;
}

export type Screen = 'found' | 'welcome' | 'first-run' | 'lock' | 'open' | 'restore' | 'unknown';

/** Which of the app's screens is up. */
export function screenOf(nodes: readonly UiNode[]): Screen {
  if (seen(nodes, words('Restore it')) && seen(nodes, words('Start new instead'))) return 'found';
  if (seen(nodes, words('Choose a passphrase')) || seen(nodes, words('Your recovery code')) || seen(nodes, words('Type it back'))) return 'first-run';
  if (seen(nodes, words('Begin')) || seen(nodes, words('Restore from a backup instead'))) return 'welcome';
  if (lockOn(nodes)) return 'lock';
  if (pastLock(nodes)) return 'open';
  if (seen(nodes, has('Choose a file')) || seen(nodes, words('Choose another file'))) return 'restore';
  return 'unknown';
}

/** The lock screen, in any of its ways: the heading, the passphrase link, or the passphrase form. */
export function lockOn(nodes: readonly UiNode[]): boolean {
  return seen(nodes, words('Locked')) || seen(nodes, words('Use your passphrase'))
    || (seen(nodes, words('Passphrase')) && seen(nodes, words('Open')) && !seen(nodes, has('Restore from a backup')));
}

/** The recovery code as the first-run screen shows it, groups in reading order. Kept in memory only. */
export function codeOnScreen(nodes: readonly UiNode[]): string | undefined {
  const groups = nodes
    .filter(n => /^[0-9A-HJKMNP-Z]{1,5}$/.test(n.text.trim()))
    .slice()
    .sort((a, b) => a.bounds[1] - b.bounds[1] || a.bounds[0] - b.bounds[0])
    .map(n => n.text.trim());
  return groups.length === 9 ? groups.join('') : undefined;
}

/** "812, 790, not done" for one item's timings; "not done" for each one missing. */
export function msList(values: readonly (number | undefined)[]): string {
  return values.map(v => (v === undefined ? 'not done' : String(v))).join(', ');
}

/** Android asked twice and the page said so first: yes only when both hold. */
export function askedTwice(pageSaid: boolean, prompts: number): string {
  return `${pageSaid && prompts === 2 ? 'yes' : 'no'} (page said so ${pageSaid ? 'yes' : 'no'}; prompts counted ${prompts})`;
}

// ---------- on the phone ----------

/** A poll that reads only while the app is in front. Out of the app it is simply not done yet. */
function look(ctx: PCtx, pred: (nodes: readonly UiNode[]) => boolean): () => boolean {
  return () => {
    if (ctx.front() !== 'app') return false;
    try {
      return pred(ctx.phone.dump());
    } catch (err) {
      if (err instanceof NotInApp) return false;
      throw err;
    }
  };
}

function inFront(ctx: PCtx, ms: number): boolean {
  const until = Date.now() + ms;
  for (;;) {
    if (ctx.front() === 'app') return true;
    if (Date.now() >= until) return false;
    pause(700);
  }
}

/** Daily Commit to the front: a prompt left up is closed, the app is started (it is singleTask, so a picker above it goes). */
function toApp(ctx: PCtx): void {
  if (ctx.front() === 'app') return;
  if (ctx.front() === 'prompt') {
    ctx.phone.key('KEYCODE_BACK');
    if (inFront(ctx, 3_000)) return;
  }
  ctx.phone.key('KEYCODE_WAKEUP');
  launch(ctx.phone, false);
  if (inFront(ctx, 8_000)) return;
  ctx.phone.shell('wm dismiss-keyguard');
  launch(ctx.phone, false);
  if (inFront(ctx, 6_000)) return;
  if (!ctx.owner.wait('Unlock the phone if it is locked, and bring Daily Commit to the front.', () => ctx.front() === 'app')) throw new NotInApp();
}

/** The screen once it has drawn the same way twice in a row. */
function settle(ctx: PCtx, ms = 60_000): Screen {
  const until = Date.now() + ms;
  let last: Screen = 'unknown';
  let same = 0;
  while (Date.now() < until) {
    const now = screenOf(ctx.phone.dump());
    same = now !== 'unknown' && now === last ? same + 1 : now === 'unknown' ? 0 : 1;
    last = now;
    if (same >= 2) return now;
    pause(600);
  }
  return last;
}

/** Waits for the record past the lock, noting whether "Opening…" was ever on screen. */
function waitOpen(ctx: PCtx, ms: number): { open: boolean; opening: boolean } {
  const until = Date.now() + ms;
  let opening = false;
  for (;;) {
    const nodes = ctx.phone.dump();
    if (seen(nodes, has('Opening…'))) opening = true;
    if (pastLock(nodes)) return { open: true, opening };
    if (Date.now() >= until) return { open: false, opening };
    pause(500);
  }
}

function dismissOffer(ctx: PCtx): void {
  if (seen(ctx.phone.dump(), has('Let Daily Commit send reminders'))) ctx.phone.tap(words('Not now'), 10_000);
}

/** The passphrase way in, from any lock screen. Returns whether "Opening…" showed. */
function byPassphrase(ctx: PCtx): boolean {
  const { phone } = ctx;
  if (seen(phone.dump(), words('Use your passphrase'))) phone.tap(words('Use your passphrase'), 10_000);
  focusSecret(phone, 'Passphrase');
  phone.type(LONG_PASSPHRASE);
  pause(300);
  phone.key('KEYCODE_ENTER');
  pause(600);
  const nodes = phone.dump();
  if (!pastLock(nodes) && seen(nodes, words('Open'))) phone.tap(words('Open'), 10_000);
  const r = waitOpen(ctx, 60_000);
  if (!r.open) throw new Error('the record did not open with the test passphrase');
  return r.opening;
}

/** The own code, from the code pad. Returns whether "Opening…" showed. */
function byCode(ctx: PCtx): boolean {
  enterDigits(ctx.phone, CODE, 'Open');
  const r = waitOpen(ctx, 60_000);
  if (!r.open) throw new Error('the record did not open with the test code');
  return r.opening;
}

/** The record open, by the script's own ways only (the code or the passphrase), never the owner's finger. */
function openRecord(ctx: PCtx): void {
  toApp(ctx);
  let screen = settle(ctx);
  if (screen === 'restore' || screen === 'unknown') {
    // A restore screen left by a picker that wasn't used: Back closes it.
    ctx.phone.key('KEYCODE_BACK');
    screen = settle(ctx, 20_000);
  }
  if (screen === 'lock') {
    if (codePad(ctx.phone)) byCode(ctx);
    else byPassphrase(ctx);
  } else if (screen !== 'open') {
    throw new Error(`the record is not on screen (${screen})`);
  }
  dismissOffer(ctx);
}

/** Home, then back in: the app locks the moment it is left (owner D-4). */
function lockAgain(ctx: PCtx): void {
  const { phone } = ctx;
  phone.key('KEYCODE_HOME');
  pause(1500);
  launch(phone, false);
  if (!inFront(ctx, 10_000)) toApp(ctx);
  const until = Date.now() + 15_000;
  while (Date.now() < until) {
    if (ctx.front() !== 'app') return;                   // Android's prompt came up by itself
    if (lockOn(phone.dump())) return;
    pause(500);
  }
  throw new Error('the lock screen did not come back');
}

function openSettings(ctx: PCtx): void {
  const { phone } = ctx;
  if (!seen(phone.dump(), words('Settings'))) phone.tap(words('Plan'), 20_000);
  phone.tap(words('Settings'), 20_000);
  scrollTo(phone, words('Privacy'));
}

/** New timing lines since the last take. The first call only sets the mark. */
class Timings {
  private mark = '';
  private readonly ctx: PCtx;
  constructor(ctx: PCtx) {
    this.ctx = ctx;
  }
  private read(): Timing[] {
    return timingsOf(this.ctx.phone.shell('logcat -d -v threadtime -s DailyCommit:V').out);
  }
  start(): void {
    const all = this.read();
    this.mark = all[all.length - 1]?.at ?? '';
  }
  take(label: Timing['label'], ms = 8_000): number | undefined {
    const until = Date.now() + ms;
    for (;;) {
      const fresh = timingsAfter(this.read(), this.mark);
      const last = fresh[fresh.length - 1];
      if (last !== undefined) this.mark = last.at;
      const hit = fresh.filter(t => t.label === label).pop();
      if (hit !== undefined) return hit.ms;
      if (Date.now() >= until) return undefined;
      pause(500);
    }
  }
}

/** The timing line on (D-5). The tag is read when the app's process starts, so the app is restarted once. */
function timingSwitch(ctx: PCtx): boolean {
  if (ctx.timingOn) return true;
  const { phone } = ctx;
  phone.shell('setprop log.tag.DailyCommit VERBOSE');
  const on = phone.shell('getprop log.tag.DailyCommit').out.trim() === 'VERBOSE';
  if (!on) return false;
  phone.shell(`am force-stop app.dailycommit`);
  pause(800);
  launch(phone, false);
  ctx.timingOn = true;
  return true;
}

/** Counts Android's prompts while the owner answers them: each time the app leaves the front and comes back. */
function promptsWhile(ctx: PCtx, what: string, finished: (nodes: readonly UiNode[]) => boolean): { done: boolean; prompts: number } {
  let prompts = 0;
  let wasApp = true;
  let stable = 0;
  const done = ctx.owner.wait(what, () => {
    const f = ctx.front();
    if (f !== 'app') {
      if (wasApp) prompts++;
      wasApp = false;
      stable = 0;
      return false;
    }
    wasApp = true;
    let nodes: readonly UiNode[];
    try {
      nodes = ctx.phone.dump();
    } catch (err) {
      if (err instanceof NotInApp) return false;
      throw err;
    }
    stable = finished(nodes) ? stable + 1 : 0;
    return stable >= 2;
  });
  return { done, prompts };
}

/** One unlock the owner gives: our button first when it is there, then the owner's finger or PIN in Android's prompt. */
function ownerUnlock(ctx: PCtx, timings: Timings, button: RegExp | undefined, what: string): { ms: number | undefined; opening: boolean } {
  const { phone } = ctx;
  lockAgain(ctx);
  if (button !== undefined && ctx.front() === 'app' && seen(phone.dump(), button)) phone.tap(button, 8_000);
  let opening = false;
  const done = ctx.owner.wait(what, look(ctx, nodes => {
    if (seen(nodes, has('Opening…'))) opening = true;
    return pastLock(nodes);
  }));
  if (!done) {
    if (ctx.front() === 'prompt') phone.key('KEYCODE_BACK');
    return { ms: undefined, opening };
  }
  return { ms: timings.take('unlock'), opening };
}

// ---------- the steps ----------

function firstRun(ctx: PCtx, screen: Screen): boolean {
  const { phone } = ctx;
  if (screen === 'found') phone.tap(words('Start new instead'), 15_000);
  if (screen === 'found' || screen === 'welcome') phone.tap(words('Begin'), 20_000);
  if (seen(phone.dump(), words('Choose a passphrase')) || phone.waitFor(words('Choose a passphrase'), 15_000)) {
    focusSecret(phone, 'Passphrase');
    phone.type(LONG_PASSPHRASE);
    phone.tap(words('Continue'), 15_000);
  }
  if (!phone.waitFor(words('Your recovery code'), 60_000) && !seen(phone.dump(), words('Type it back'))) {
    throw new Error('the recovery code screen did not come');
  }
  const code = codeOnScreen(phone.dump());
  const done = ctx.owner.wait(
    "Write the first group of the recovery code on the paper, tap \"I've written it down\", type the whole code back with the phone's keyboard, and tap Finish. If Android then asks for your fingerprint or PIN, give it.",
    look(ctx, nodes => pastLock(nodes)),
  );
  if (done) {
    ctx.note('P3 the recovery code was typed back on the phone\'s keyboard');
    return true;
  }
  // The owner didn't finish in time. The script finishes, and the keyboard check for the code is void.
  toApp(ctx);
  if (code === undefined) return false;
  if (seen(phone.dump(), words("I've written it down"))) phone.tap(words("I've written it down"), 10_000);
  if (!phone.waitFor(words('Type it back'), 15_000)) return false;
  focusSecret(phone, 'Recovery code, typed back');
  phone.type(code);
  phone.tap(words('Finish'), 15_000);
  ctx.note('P3 the script typed the recovery code back, so P7\'s recovery-code answer is void');
  if (ctx.front() !== 'app') ctx.owner.wait('If Android asks for your fingerprint or PIN, give it.', look(ctx, nodes => pastLock(nodes)));
  return waitOpen(ctx, 60_000).open;
}

function diaryWord(ctx: PCtx): void {
  const { phone } = ctx;
  phone.tap(words('Diary'), 20_000);
  focusDiaryPage(phone);
  const typed = ctx.owner.wait(`On the diary page, type "${DIARY_WORDS}" with the phone's keyboard.`, look(ctx, nodes => seen(nodes, has('Vextromil'))));
  if (typed) ctx.note('P3 the diary word was typed on the phone\'s keyboard');
  else {
    toApp(ctx);
    if (!seen(phone.dump(), has('Vextromil'))) {
      focusDiaryPage(phone);
      phone.type(DIARY_WORDS);
    }
    ctx.note('P3 the script typed the diary word, so P7\'s diary-word answer is void');
  }
  pause(800);
  phone.key('KEYCODE_BACK');                             // the keyboard down; the page saves as it loses focus
  pause(600);
  if (ctx.front() !== 'app' || !seen(phone.dump(), words('Today'))) toApp(ctx);
  phone.tap(words('Today'), 15_000);
}

function p3(ctx: PCtx): void {
  toApp(ctx);
  const screen = settle(ctx);
  if (screen === 'found' || screen === 'welcome' || screen === 'first-run') {
    ctx.record('P3.firstRun', firstRun(ctx, screen) ? 'yes' : 'no');
  } else if (screen === 'lock' || screen === 'open') {
    ctx.record('P3.firstRun', 'yes (finished before this run)');
  } else {
    throw new Error(`the app's first screen was not recognised (${screen})`);
  }
  openRecord(ctx);
  diaryWord(ctx);
  openSettings(ctx);
  scrollTo(ctx.phone, has('kept in the app'));
  ctx.record('P3.storage', storageAnswer(ctx.phone.dump()) ?? 'not readable (the line was not on screen)');
}

function p4(ctx: PCtx): void {
  const { phone } = ctx;
  toApp(ctx);
  const tag = timingSwitch(ctx);
  ctx.record('P4.timingTag', tag ? 'yes' : 'no');
  openRecord(ctx);
  const timings = new Timings(ctx);
  timings.start();
  if (!ctx.pushLong()) {
    ctx.record('P4.restored', 'no (the invented file could not be copied to Download)');
    return;
  }
  phone.shell('am broadcast -a android.intent.action.MEDIA_SCANNER_SCAN_FILE -d file:///sdcard/Download/dc-3year.dcbak');
  openSettings(ctx);
  scrollTo(phone, has('Restore from a backup'));
  phone.tap(has('Restore from a backup'), 20_000);
  if (!phone.waitFor(has('Choose a file'), 20_000)) throw new Error('the restore screen did not open');
  phone.tap(has('Choose a file'), 20_000);
  const picked = ctx.owner.wait(
    "In Android's file picker, open Downloads and choose dc-3year.dcbak.",
    look(ctx, nodes => seen(nodes, words('Passphrase')) || seen(nodes, has('Replace everything')) || seen(nodes, words('Choose another file'))),
  );
  if (!picked) {
    ctx.record('P4.restored', 'no (the file was not picked)');
    toApp(ctx);
    return;
  }
  ctx.record('P4.stayedOpen', lockOn(phone.dump()) ? 'no' : 'yes');
  if (seen(phone.dump(), has('Replace everything'))) phone.tap(words('Replace everything'), 15_000);
  focusSecret(phone, 'Passphrase');
  phone.type(LONG_PASSPHRASE);
  phone.tap(words('Restore'), 20_000);
  if (phone.waitFor(has('Replace everything'), 12_000)) phone.tap(words('Replace everything'), 15_000);
  if (!phone.waitFor(words('Restored'), 180_000)) {
    ctx.record('P4.restored', 'no');
    return;
  }
  ctx.record('P4.restored', 'yes');
  const ms = timings.take('restore');
  phone.tap(words('Open'), 20_000);
  if (!phone.waitFor(words('Passphrase'), 30_000) && !phone.waitFor(words('Locked'), 8_000)) throw new Error('the restored record did not reach its lock screen');
  const opening = byPassphrase(ctx);
  ctx.record('P4.opening', opening ? 'yes' : 'no');
  ctx.record('P4.restoreMs', ms !== undefined ? String(ms) : tag ? 'not readable (no restore line)' : 'not readable (the timing switch was refused)');
  dismissOffer(ctx);
}

function p5(ctx: PCtx): void {
  const { phone } = ctx;
  toApp(ctx);
  timingSwitch(ctx);
  openRecord(ctx);
  const timings = new Timings(ctx);
  timings.start();
  const unlocks: number[] = [];
  let opening = false;
  const add = (r: { ms: number | undefined; opening: boolean }) => {
    if (r.ms !== undefined) unlocks.push(r.ms);
    opening ||= r.opening;
    return r.ms;
  };

  // The phone's lock: set up, then three fingerprints and two PINs.
  openSettings(ctx);
  scrollTo(phone, has("Your phone's lock"));
  if (seen(phone.dump(), has('This phone has no screen lock'))) {
    ctx.record('P5.phoneLockTwice', 'not offered (the phone has no screen lock)');
    ctx.record('P5.fingerMs', 'not done (no screen lock)');
    ctx.record('P5.pinMs', 'not done (no screen lock)');
  } else {
    phone.tap(has("Your phone's lock"), 20_000);
    const pageSaid = phone.waitFor(has('Android asks twice'), 10_000);
    focusSecret(phone, 'Passphrase');
    phone.type(LONG_PASSPHRASE);
    phone.tap(words('Continue'), 15_000);
    const set = promptsWhile(ctx, 'Android asks for your fingerprint twice: touch the sensor each time.',
      nodes => !seen(nodes, has('Android asks twice')) && !seen(nodes, words('Passphrase')) && seen(nodes, has("Your phone's lock")));
    ctx.record('P5.phoneLockTwice', set.done ? askedTwice(pageSaid, set.prompts) : `not done (prompts counted ${set.prompts})`);
    if (!set.done) toApp(ctx);
    const finger: (number | undefined)[] = [];
    for (let i = 0; i < 3; i++) {
      finger.push(add(ownerUnlock(ctx, timings, words('Unlock with fingerprint'), `Open Daily Commit with your fingerprint (${i + 1} of 3).`)));
    }
    ctx.record('P5.fingerMs', msList(finger));
    const pin: (number | undefined)[] = [];
    for (let i = 0; i < 2; i++) {
      pin.push(add(ownerUnlock(ctx, timings, has("Use your phone's PIN or pattern"), `Open Daily Commit with your phone's PIN: in Android's prompt tap "Use PIN" if it shows, then type it (${i + 1} of 2).`)));
    }
    ctx.record('P5.pinMs', msList(pin));
    openRecord(ctx);
  }

  // The own code: set up, three opens by the script, then the fingerprint switch and one fingerprint.
  openSettings(ctx);
  scrollTo(phone, has('A separate code'));
  phone.tap(has('A separate code'), 15_000);
  if (phone.waitFor(words('Passphrase'), 10_000)) {
    focusSecret(phone, 'Passphrase');
    phone.type(LONG_PASSPHRASE);
    phone.tap(words('Continue'), 15_000);
    enterDigits(phone, CODE, 'Next');
    enterDigits(phone, CODE, 'Set the code');
    if (!phone.waitFor(words('Done'), 25_000)) throw new Error('the code was not set');
    phone.tap(words('Done'), 15_000);
  } else {
    ctx.note('P5 the separate code was already set (an earlier run)');
  }
  const code: (number | undefined)[] = [];
  for (let i = 0; i < 3; i++) {
    lockAgain(ctx);
    if (ctx.front() === 'prompt') phone.key('KEYCODE_BACK');
    if (!codePad(phone)) throw new Error('the lock screen did not offer the code pad');
    opening ||= byCode(ctx);
    code.push(add({ ms: timings.take('unlock'), opening: false }));
  }
  ctx.record('P5.codeMs', msList(code));
  dismissOffer(ctx);

  openSettings(ctx);
  scrollTo(phone, has('Fingerprint opens it too'));
  phone.tap(has('Fingerprint opens it too'), 15_000);
  const asked = phone.waitFor(has('Letting the fingerprint'), 12_000) || phone.waitFor(has('Android asks twice'), 6_000);
  if (!asked) {
    ctx.record('P5.fingerSwitchTwice', 'no (the switch did not ask for the passphrase)');
    ctx.record('P5.codeFingerMs', 'not done');
  } else {
    const pageSaid = seen(phone.dump(), has('Android asks twice'));
    focusSecret(phone, 'Passphrase');
    phone.type(LONG_PASSPHRASE);
    phone.tap(words('Continue'), 15_000);
    const set = promptsWhile(ctx, 'Android asks for your fingerprint again: touch the sensor each time it asks.',
      nodes => !seen(nodes, has('Letting the fingerprint')) && !seen(nodes, words('Passphrase')) && seen(nodes, has('Fingerprint opens it too')));
    ctx.record('P5.fingerSwitchTwice', set.done ? askedTwice(pageSaid, set.prompts) : `not done (prompts counted ${set.prompts})`);
    if (!set.done) toApp(ctx);
    const one = add(ownerUnlock(ctx, timings, words('Use fingerprint'), 'Open Daily Commit with your fingerprint (on the code pad).'));
    ctx.record('P5.codeFingerMs', msList([one]));
  }
  openRecord(ctx);

  // Look back, twice.
  const lookback: (number | undefined)[] = [];
  for (let i = 0; i < 2; i++) {
    phone.tap(words('Look back'), 20_000);
    lookback.push(timings.take('lookback', 15_000));
    phone.tap(words('Today'), 20_000);
  }
  ctx.record('P5.lookbackMs', msList(lookback));
  ctx.record('P5.opening', opening ? 'yes' : 'no');
  ctx.record('P5.over10s', unlocks.length === 0 ? 'not readable (no unlock timed)' : unlocks.some(ms => ms > 10_000) ? 'yes' : 'no');
}

function p6(ctx: PCtx): void {
  openRecord(ctx);
  ctx.record('P6.screenshot', ctx.owner.ask('P6.screenshot', 'With Daily Commit open, press the side key and volume down together. Did Android refuse the screenshot, with nothing new in Gallery?'));
  openRecord(ctx);
  ctx.record('P6.recents', ctx.owner.ask('P6.recents', "Open Recents and look at Daily Commit's card. Does it show nothing of the record?"));
  openRecord(ctx);
  ctx.record('P6.blinkIcon', ctx.owner.ask('P6.blinkIcon', 'Press Home, wait 3 seconds, open Daily Commit from its icon and watch the first instant. Did anything of the record show, even for a blink, before the lock screen?'));
  openRecord(ctx);
  ctx.record('P6.blinkRecents', ctx.owner.ask('P6.blinkRecents', "Press Home, then open Daily Commit from its card in Recents. Did anything of the record show before the lock screen?"));
  openRecord(ctx);
  ctx.record('P6.blinkScreen', ctx.owner.ask('P6.blinkScreen', 'Press the side key to turn the screen off, then on, and unlock the phone. Did anything of the record show before Daily Commit\'s lock screen?'));
  openRecord(ctx);
}

function p7(ctx: PCtx): void {
  openRecord(ctx);
  ctx.record('P7.keyboard', keyboardName(ctx.phone.shell('settings get secure default_input_method').out));
  ctx.record('P7.diaryWord', ctx.owner.ask('P7.diaryWord', 'In a text field where nothing is sent (a new note in Notes), type "Vex". Is "Vextromil" offered in the suggestion bar? If it is, long-press it and remove it, then discard the note.'));
  ctx.record('P7.codeGroup', ctx.owner.ask('P7.codeGroup', 'In that field, type the first three characters of the group on your paper. Is the rest of the group offered? If it is, remove it, then discard the note.'));
}

function p8(ctx: PCtx): void {
  const { phone } = ctx;
  openRecord(ctx);
  phone.tap(words('Diary'), 20_000);
  focusDiaryPage(phone);
  phone.type(SCREEN_OFF_WORDS);
  phone.key('KEYCODE_SLEEP');
  pause(1500);
  phone.key('KEYCODE_WAKEUP');
  pause(800);
  phone.shell('wm dismiss-keyguard');
  pause(800);
  toApp(ctx);
  const screen = settle(ctx, 20_000);
  if (screen === 'lock') {
    if (codePad(phone)) byCode(ctx);
    else byPassphrase(ctx);
  }
  dismissOffer(ctx);
  if (!seen(phone.dump(), has('CANARY typed screen off'))) {
    if (!seen(phone.dump(), words('Earlier'))) phone.tap(words('Diary'), 20_000);
    phone.waitFor(has('CANARY typed screen off'), 8_000);
  }
  ctx.record('P8.kept', seen(phone.dump(), has('CANARY typed screen off')) ? 'yes' : 'no');
}

export const RUN: Readonly<Record<Step, (ctx: PCtx) => void>> = { P3: p3, P4: p4, P5: p5, P6: p6, P7: p7, P8: p8 };
