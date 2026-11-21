// The one place the app's Android id is written. The release app is `app.dailycommit`; the tests build
// (Phase 2 of the tablet gate) is `app.dailycommit.tests`, a separate app to Android with its own data, so a
// test install never touches the release app. The Java package stays `app.dailycommit` in both builds, so
// the screen to start is always named in full: `<id>/app.dailycommit.MainActivity`.
// A leaf: it imports nothing, so every script and the gate can read it without a cycle.

export const RELEASE_ID = 'app.dailycommit';
export const TESTS_ID = 'app.dailycommit.tests';
/** The launcher screen's class, the same in both builds. A relative `.MainActivity` would resolve under the tests id to a class that doesn't exist. */
export const ACTIVITY = 'app.dailycommit.MainActivity';

/** The flags that say a run is about the tests build. */
const TESTS_FLAGS = ['--tests', '--tablet', '--tests-build'];

/** Whether this run is about the tests build: `DC_TESTS_BUILD=1`, or one of the tests flags on the command line. */
export function testsBuild(argv: readonly string[], env: Readonly<Record<string, string | undefined>>): boolean {
  return env.DC_TESTS_BUILD === '1' || argv.some(a => TESTS_FLAGS.includes(a));
}

/** The id this run works with, decided once when the file loads. */
export const APP_ID: string = testsBuild(process.argv, process.env) ? TESTS_ID : RELEASE_ID;

/** `am start` for one id's launcher screen; `wait` adds -W. */
export function startCommand(id: string, wait: boolean): string {
  return `am start ${wait ? '-W ' : ''}-n ${id}/${ACTIVITY}`;
}

const escaped = (id: string) => id.replace(/\./g, '\\.');

/**
 * The part of a focus line that names one id's window: the id, then `/`, after a space or `{`. The `/` right
 * after the id is what keeps `app.dailycommit/` from matching `app.dailycommit.tests/` and the reverse.
 * As text for `grep -E` on the device.
 */
export function focusPattern(id: string): string {
  return `[ {]${escaped(id)}/`;
}

/** The same, as a JavaScript pattern for reading a focus line here. */
export function focusRegExp(id: string): RegExp {
  return new RegExp(`[\\s{]${escaped(id)}/`);
}

/** The app's own data folder for the device's first user (emulator and phone runs only). */
export function dataDir(id: string): string {
  return `/data/user/0/${id}`;
}
