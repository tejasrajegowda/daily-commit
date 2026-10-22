// The shell list the phone guard and the adb gate both read. Neither imports the other, so this file
// stays the leaf they share.

export const APP = 'app.dailycommit';
export const LONG_REMOTE = '/sdcard/Download/dc-3year.dcbak';
/** One file, through MediaStore's own scan. The scanner broadcast is ignored on Android 13. */
export const SCAN_LONG = `content call --uri content://media --method scan_file --arg ${LONG_REMOTE}`;

/** What the phone answers when its own focus check fails. */
export const NOT_FRONT = 'DC-NOT-IN-FRONT';

/** The focus line the guard reads before it acts. It is not a command shellKind allows on its own. */
export const FOCUS_READ = 'dumpsys window | grep mCurrentFocus';

/** A command the guard never sends. */
export class Refused extends Error {
  constructor(what: string) {
    super(`refused: ${what}`);
    this.name = 'Refused';
  }
}

/** What a shell command may do: act inside the app only, act anywhere (leave, launch our app, the timing switch), read, or nothing. */
export type ShellKind = 'in-app' | 'in-app-or-prompt' | 'anywhere' | 'read' | 'refused';

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

const FOCUS_APP = String.raw`[ {]app\.dailycommit/`;
const FOCUS_PROMPT = 'BiometricPrompt|ConfirmDeviceCredential|ConfirmLock';

function focusPattern(allowPrompt: boolean): string {
  return allowPrompt ? `${FOCUS_APP}|${FOCUS_PROMPT}` : FOCUS_APP;
}

/**
 * `command`, run on the phone only if Daily Commit (or, with `allowPrompt`, Android's own prompt) has the focus
 * at that moment: the check and the command are one shell call, so nothing can come up between them.
 */
export function onlyInFront(command: string, allowPrompt: boolean): string {
  return `if dumpsys window | grep mCurrentFocus | head -n 1 | grep -qE '${focusPattern(allowPrompt)}'; then ${command}; else echo ${NOT_FRONT}; fi`;
}

/** The inner command of an onlyInFront string, when the string is exactly that shape. */
export function envelopeOf(text: string): { readonly command: string; readonly allowPrompt: boolean } | undefined {
  for (const allowPrompt of [false, true] as const) {
    const prefix = `if dumpsys window | grep mCurrentFocus | head -n 1 | grep -qE '${focusPattern(allowPrompt)}'; then `;
    const suffix = `; else echo ${NOT_FRONT}; fi`;
    if (!text.startsWith(prefix) || !text.endsWith(suffix)) continue;
    const command = text.slice(prefix.length, text.length - suffix.length);
    if (onlyInFront(command, allowPrompt) === text) return { command, allowPrompt };
  }
  return undefined;
}

// A screen read goes to a file in the shell's own folder (not shared storage), is read back and removed in the
// same call. Under `exec-out` some builds won't open /dev/tty, so a file is used, as Task 8's driver does.
const DUMP_FILE = '/data/local/tmp/dc-ui.xml';
export const DUMP_COMMAND = onlyInFront(`uiautomator dump ${DUMP_FILE} >/dev/null && cat ${DUMP_FILE}; rm -f ${DUMP_FILE}`, false);
