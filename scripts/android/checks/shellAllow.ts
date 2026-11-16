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

// ─── the tablet's Tests user (D-36) ───
// On the tablet everything runs in Android user 10, the Tests user. The commands that address a user
// (or every user) when none is named go there only in a form that names user 10.

export const TESTS_USER = 10;

/** What the tablet answers when the Tests user was not the one on screen: the command did not run. */
export const NOT_TESTS_USER = 'DC-NOT-TESTS-USER';

/** The tablet stops: the Tests user is not on screen. A Refused, so a run stops on it as on any refusal. */
export class NotTestsUser extends Refused {
  constructor() {
    super('the Tests user is not the one on screen');
    this.name = 'NotTestsUser';
  }
}

/** `command`, run on the tablet only while the Tests user is the one on screen: the check and the command are one shell call. */
export function inTestsUser(command: string): string {
  return `if [ "$(am get-current-user)" = ${TESTS_USER} ]; then ${command}; else echo ${NOT_TESTS_USER}; fi`;
}

/** The invented long file, in the Tests user's own storage. */
export const TESTS_LONG_REMOTE = `/storage/emulated/${TESTS_USER}/Download/dc-3year.dcbak`;

/** Where adb puts the invented long file first: the shell's own folder, no user's storage. */
export const TESTS_LONG_TMP = '/data/local/tmp/dc-3year.dcbak';
const DOWNLOADS = 'content://media/external/downloads';
const LONG_NAME = "--where \"_display_name='dc-3year.dcbak'\"";
/**
 * adb can't write into another user's storage, so the file goes in through that user's media library: the old one
 * removed, a new Downloads entry made, its bytes written from the shell's folder, which is then emptied. Prints
 * DC-LONG-IN when the bytes went in. On the tablet lane only.
 */
export const TESTS_LONG_INTO_DOWNLOADS = [
  `content delete --user ${TESTS_USER} --uri ${DOWNLOADS} ${LONG_NAME}`,
  `content insert --user ${TESTS_USER} --uri ${DOWNLOADS} --bind _display_name:s:dc-3year.dcbak --bind mime_type:s:application/octet-stream`,
  `id=$(content query --user ${TESTS_USER} --uri ${DOWNLOADS} --projection _id ${LONG_NAME} | sed -n 's/.*_id=\\([0-9]*\\).*/\\1/p' | head -n 1)`,
  `if [ -n "$id" ] && content write --user ${TESTS_USER} --uri ${DOWNLOADS}/$id < ${TESTS_LONG_TMP}; then echo DC-LONG-IN; fi`,
  `rm -f ${TESTS_LONG_TMP}`,
].join('; ');

/**
 * The tablet ignores the wake key while its screen is off, so it is woken with its power key, and only when its
 * screen reads as asleep at that same moment: the read and the key are one call, so a lit screen is never switched
 * off. The one line read is the screen's state (Awake, Asleep, Dozing). On the tablet lane only.
 */
export const TESTS_WAKE = "if dumpsys power 2>/dev/null | grep -m1 'mWakefulness=' | grep -qE 'Asleep|Dozing'; then input keyevent KEYCODE_POWER; fi";
export const TESTS_WAKEFULNESS = "dumpsys power 2>/dev/null | grep -m1 'mWakefulness='";
/** The phone's user-addressing commands and their Tests-user forms (the wake key is the tablet's power key, guarded). */
const TESTS_FORMS: ReadonlyMap<string, string> = new Map([
  [`am start -n ${APP}/.MainActivity`, `am start --user ${TESTS_USER} -n ${APP}/.MainActivity`],
  [`am start -W -n ${APP}/.MainActivity`, `am start --user ${TESTS_USER} -W -n ${APP}/.MainActivity`],
  [`am force-stop ${APP}`, `am force-stop --user ${TESTS_USER} ${APP}`],
  [`pm path ${APP}`, `pm path --user ${TESTS_USER} ${APP}`],
  ['settings get secure default_input_method', `settings --user ${TESTS_USER} get secure default_input_method`],
  ['input keyevent KEYCODE_WAKEUP', TESTS_WAKE],
  [SCAN_LONG, `content call --user ${TESTS_USER} --uri content://media --method scan_file --arg ${TESTS_LONG_REMOTE}`],
]);
const FROM_TESTS_FORM: ReadonlyMap<string, string> = new Map([...TESTS_FORMS].map(([base, form]) => [form, base]));

/** Clears the Tests user's copy of the app's data only. On the tablet lane alone. */
export const CLEAR_TESTS_DATA = `pm clear --user ${TESTS_USER} ${APP}`;

/** The command as the tablet sends it: a user-addressing one in its Tests-user form, any other as it is. */
export function forTestsUser(command: string): string {
  return TESTS_FORMS.get(command.trim()) ?? command;
}

// The stand-in for the owner in the Tests user: the whole screen there is ours to read and act on (the
// owner's account is never on screen while these run), so it reads the whole screen and the keyboard's state.
const SCREEN_FILE = '/data/local/tmp/dc-screen.xml';
/** The whole screen of the Tests user, read and removed in one call. On the tablet lane only. */
export const TESTS_SCREEN_DUMP = `uiautomator dump ${SCREEN_FILE} >/dev/null && cat ${SCREEN_FILE}; rm -f ${SCREEN_FILE}`;
/**
 * The log lines of Daily Commit's own process in the Tests user, by its pid (the owner's account has no copy of
 * the app while the tablet lane installs one, so the pid is the Tests user's). On the tablet lane only.
 */
export const TESTS_APP_LOG = `logcat -d -v threadtime --pid=$(pidof -s ${APP})`;
/** Only the focused field's lines of the keyboard's state. On the tablet lane only. */
export const TESTS_IME_READ = "dumpsys input_method | grep -E 'mCurEditorInfo|mCurAttribute|mInputEditorInfo|imeOptions'";


/**
 * shellKind on the tablet: a user-addressing command only in its Tests-user form; its bare form is refused.
 * Taps, swipes, typing and the steps' keys may act anywhere on the Tests user's screen (the stand-in works in
 * Android's file picker), plus the Recents key; the gate's own check keeps all of it inside the Tests user.
 */
export function testsShellKind(command: string): ShellKind {
  const c = command.trim();
  if (c === CLEAR_TESTS_DATA || c === TESTS_LONG_INTO_DOWNLOADS) return 'anywhere';
  if (c === TESTS_SCREEN_DUMP || c === TESTS_IME_READ || c === TESTS_WAKEFULNESS || c === TESTS_APP_LOG) return 'read';
  if (c === 'input keyevent KEYCODE_APP_SWITCH') return 'anywhere';
  const base = FROM_TESTS_FORM.get(c);
  if (base !== undefined) return shellKind(base);
  if (TESTS_FORMS.has(c)) return 'refused';
  const kind = shellKind(c);
  return kind === 'in-app' || kind === 'in-app-or-prompt' ? 'anywhere' : kind;
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
