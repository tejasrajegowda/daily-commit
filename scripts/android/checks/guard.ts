// The privacy guard for driving a real phone. Every read and every tap first checks that Daily Commit
// is the focused window; anything else stops the step with "not in the app" and nothing is read.
// The phone checks the focus again in the same call, right before it taps or reads, so an app that
// comes up in between is never tapped or read.
// Only nodes of Daily Commit's own package leave a screen dump. The shell takes a short list of
// commands and refuses the rest, so a screenshot, a recording, another app's data or a wipe can't be
// sent by mistake. An emulator is never the phone; the dry run names emulator-5556 on purpose.
import { nodesOf, type DeviceIo, type UiNode } from '../drive.ts';
import { devicesOf } from '../phone.ts';

export const APP = 'app.dailycommit';
export const DRY_RUN_SERIAL = 'emulator-5556';
export const NOT_IN_APP = 'not in the app';

/** The step stops here. Its message is the whole of what is said. */
export class NotInApp extends Error {
  constructor() {
    super(NOT_IN_APP);
    this.name = 'NotInApp';
  }
}

/** A command the guard never sends. */
export class Refused extends Error {
  constructor(what: string) {
    super(`refused: ${what}`);
    this.name = 'Refused';
  }
}

export type Front = 'app' | 'prompt' | 'other';

/** Who has the focus, from the `mCurrentFocus` line alone. A prompt is Android's own credential or fingerprint window. */
export function frontOf(focusLines: string): Front {
  const line = focusLines.split(/\r?\n/).find(l => l.includes('mCurrentFocus')) ?? '';
  if (/[\s{]app\.dailycommit\//.test(line)) return 'app';
  if (/BiometricPrompt|ConfirmDeviceCredential|ConfirmLock/.test(line)) return 'prompt';
  return 'other';
}

/** Daily Commit's own nodes. A node of any other package, or with no package, is dropped before anything reads it. */
export function oursOnly(nodes: readonly UiNode[]): UiNode[] {
  return nodes.filter(n => n.pkg === APP);
}

/** The one real phone attached, by `npm run phone`'s rule. An emulator is never the phone. */
export function phoneTarget(adbDevices: string): { readonly ok: true; readonly serial: string } | { readonly ok: false; readonly why: string } {
  const phones = devicesOf(adbDevices).filter(d => d.state === 'device' && !d.serial.startsWith('emulator-'));
  const only = phones[0];
  if (phones.length === 1 && only !== undefined) return { ok: true, serial: only.serial };
  if (phones.length === 0) return { ok: false, why: 'No phone is attached with USB debugging allowed. Nothing was run.' };
  return { ok: false, why: `${phones.length} phones are attached. Unplug all but one. Nothing was run.` };
}

/** What a shell command may do: act inside the app only, act anywhere (leave, launch our app, the timing switch), read, or nothing. */
export type ShellKind = 'in-app' | 'in-app-or-prompt' | 'anywhere' | 'read' | 'refused';

const LONG_REMOTE = '/sdcard/Download/dc-3year.dcbak';
/** One file, through MediaStore's own scan. The scanner broadcast is ignored on Android 13. */
export const SCAN_LONG = `content call --uri content://media --method scan_file --arg ${LONG_REMOTE}`;
const ANYWHERE_KEYS = new Set(['KEYCODE_HOME', 'KEYCODE_WAKEUP', 'KEYCODE_SLEEP']);
// The keys the steps press inside the app. Any other key (the screenshot key, one that opens another app) is refused.
const IN_APP_KEYS = new Set(['KEYCODE_ENTER', ...'0123456789'.split('').map(d => `KEYCODE_${d}`)]);

/** The guard's list. Anything not on it is refused. */
export function shellKind(command: string): ShellKind {
  const c = command.trim();
  const key = /^input keyevent ([A-Z0-9_]+)$/.exec(c)?.[1];
  if (key !== undefined) {
    if (ANYWHERE_KEYS.has(key)) return 'anywhere';
    if (key === 'KEYCODE_BACK') return 'in-app-or-prompt';
    return IN_APP_KEYS.has(key) ? 'in-app' : 'refused';
  }
  if (/^input tap \d+ \d+$/.test(c)) return 'in-app';
  if (/^input swipe \d+ \d+ \d+ \d+ \d+$/.test(c)) return 'in-app';
  // inputTextArg's output only: no spaces, and each of the shell's specials escaped, so nothing after it can run.
  if (/^input text (?:\\.|[^\s\\'"$&|;<>()[\]{}*?!~`^#])+$/.test(c)) return 'in-app';
  if (c === `am start -n ${APP}/.MainActivity` || c === `am start -W -n ${APP}/.MainActivity`) return 'anywhere';
  if (c === `am force-stop ${APP}`) return 'anywhere';
  if (c === 'wm dismiss-keyguard') return 'anywhere';
  if (c === 'setprop log.tag.DailyCommit VERBOSE' || c === 'setprop log.tag.DailyCommit ""') return 'anywhere';
  if (c === SCAN_LONG) return 'anywhere';
  if (c === 'wm size' || c === 'date +%s') return 'read';
  if (c === 'logcat -d -v threadtime -s DailyCommit:V') return 'read';
  if (c === 'getprop log.tag.DailyCommit') return 'read';
  if (c === `pm path ${APP}`) return 'read';
  if (c === 'settings get secure default_input_method') return 'read';
  return 'refused';
}

export type Adb = (args: readonly string[], timeoutMs?: number) => { readonly code: number; readonly out: string };

export interface GuardedPhone extends DeviceIo {
  readonly serial: string;
  /** Who has the focus now. Never printed beyond these three words. */
  front(): Front;
  /** Copies the invented long record to the phone's Download folder. */
  pushLong(localPath: string): boolean;
}

/** What the phone answers when its own focus check fails. */
export const NOT_FRONT = 'DC-NOT-IN-FRONT';

const FOCUS_APP = String.raw`[ {]app\.dailycommit/`;
const FOCUS_PROMPT = 'BiometricPrompt|ConfirmDeviceCredential|ConfirmLock';

/**
 * `command`, run on the phone only if Daily Commit (or, with `allowPrompt`, Android's own prompt) has the focus
 * at that moment: the check and the command are one shell call, so nothing can come up between them.
 */
export function onlyInFront(command: string, allowPrompt: boolean): string {
  const focus = allowPrompt ? `${FOCUS_APP}|${FOCUS_PROMPT}` : FOCUS_APP;
  return `if dumpsys window | grep mCurrentFocus | head -n 1 | grep -qE '${focus}'; then ${command}; else echo ${NOT_FRONT}; fi`;
}

// A screen read goes to a file in the shell's own folder (not shared storage), is read back and removed in the
// same call. Under `exec-out` some builds won't open /dev/tty, so a file is used, as Task 8's driver does.
const DUMP_FILE = '/data/local/tmp/dc-ui.xml';
export const DUMP_COMMAND = onlyInFront(`uiautomator dump ${DUMP_FILE} >/dev/null && cat ${DUMP_FILE}; rm -f ${DUMP_FILE}`, false);

/** The text between `<hierarchy` and `</hierarchy>` of a uiautomator dump, or '' when there is none. */
export function hierarchyOf(out: string): string {
  const start = out.indexOf('<hierarchy');
  const end = out.lastIndexOf('</hierarchy>');
  return start >= 0 && end > start ? out.slice(start, end + '</hierarchy>'.length) : '';
}

/**
 * The phone, through the guard. `serial` must be a real phone; only `dryRun` lets emulator-5556 stand in.
 * Nothing here prints; a caller sees only the nodes of Daily Commit and the three words of `front()`.
 */
export function guardedPhone(serial: string, adb: Adb, opts: { readonly dryRun?: boolean } = {}): GuardedPhone {
  if (serial.startsWith('emulator-') && !(opts.dryRun === true && serial === DRY_RUN_SERIAL)) {
    throw new Refused('an emulator is not the phone');
  }
  if (opts.dryRun === true && serial !== DRY_RUN_SERIAL) throw new Refused('the dry run uses only emulator-5556');
  // adb names the serial in its own errors ("device '…' not found"); it is cut out here, so no error line carries it.
  const run = (args: readonly string[], timeoutMs?: number) => {
    const r = adb(['-s', serial, ...args], timeoutMs);
    return { code: r.code, out: r.out.split(serial).join('the phone') };
  };
  const front = (): Front => frontOf(run(['shell', 'dumpsys window | grep mCurrentFocus'], 20_000).out);
  const io: GuardedPhone = {
    serial,
    front,
    shell(command: string) {
      const kind = shellKind(command);
      if (kind === 'refused') throw new Refused('that command is not on the guard\'s list');
      if (kind === 'in-app' && front() !== 'app') throw new NotInApp();
      if (kind === 'in-app-or-prompt' && front() === 'other') throw new NotInApp();
      if (kind !== 'in-app' && kind !== 'in-app-or-prompt') return run(['shell', command], 60_000);
      const r = run(['shell', onlyInFront(command, kind === 'in-app-or-prompt')], 60_000);
      if (r.out.includes(NOT_FRONT)) throw new NotInApp();
      return r;
    },
    execOut() {
      throw new Refused('no raw reads from the phone');
    },
    dump() {
      if (front() !== 'app') throw new NotInApp();
      const r = run(['shell', DUMP_COMMAND], 60_000);
      if (r.out.includes(NOT_FRONT)) throw new NotInApp();
      const xml = hierarchyOf(r.out);
      if (xml === '') return undefined;
      // Nothing of the xml is kept: only Daily Commit's nodes go on.
      return { xml: '', nodes: oursOnly(nodesOf(xml)) };
    },
    finger() {
      throw new Refused('the fingerprint is the owner\'s');
    },
    pushLong(localPath: string) {
      return run(['push', localPath, LONG_REMOTE], 120_000).code === 0;
    },
  };
  return io;
}
