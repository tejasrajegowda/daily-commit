// The only place under scripts/android that starts adb. The verdict is pure: a refused command throws
// before the tool path is looked up and before any process is started.
import { spawnSync } from 'node:child_process';
import { closeSync, openSync } from 'node:fs';
import { RELEASE_ID, TESTS_ID } from './appId.ts';
import {
  DUMP_COMMAND, FOCUS_READ, LONG_REMOTE, NOT_TESTS_USER, NotTestsUser, Refused, TESTS_LONG_TMP, TESTS_USER,
  envelopeOf, inTestsUser, shellKind, testsShellKind,
} from './checks/shellAllow.ts';
import { childEnv, toolchain, toolPaths } from './env.ts';

/**
 * install: the version read and `install -r --user 0` (the phone, the emulator, or the owner's account on its
 * owner's word). phoneChecks: the phone sitting. emulator: emulator-5556 only. tablet: the tablet's Tests user
 * (user 10) only; every shell command is sent inside a check that the Tests user is the one on screen (D-36).
 */
export type Lane = 'install' | 'phoneChecks' | 'emulator' | 'tablet';

/**
 * The one APK the tablet may install: the tests build's file. The tests build is a separate app (TESTS_ID), so
 * installing it in the Tests user never touches the owner's copy of Daily Commit, and nothing of the owner's
 * account needs to be read to know that (Phase 2; phone.ts also checks the file's id before it gets here).
 */
export const TESTS_APK_NAME = 'app-tests-release.apk';

/** The test emulator. install and phoneChecks may name the one real phone; this lane may not. */
export const EMULATOR_SERIAL = 'emulator-5556';

export type AdbVerdict = { readonly ok: true } | { readonly ok: false; readonly why: string };

const EMULATOR_ONLY = 'adb may address only emulator-5556';

type Head =
  | { readonly kind: 'devices' }
  | { readonly kind: 'refuse'; readonly why: string }
  | { readonly kind: 'second-s' }
  | { readonly kind: 'cmd'; readonly serial: string; readonly verb: string; readonly rest: readonly string[] };

function headOf(args: readonly string[]): Head {
  const first = args[0];
  if (args.length === 1 && first === 'devices') return { kind: 'devices' };
  if (first !== '-s') return { kind: 'refuse', why: 'a command names one serial with -s before the verb' };
  const serial = args[1];
  if (serial === undefined || serial === '' || serial.startsWith('-')) return { kind: 'refuse', why: 'the serial is missing' };
  for (let i = 2; i < args.length; i++) {
    const tok = args[i];
    if (tok === undefined) break;
    if (tok === '-s') return { kind: 'second-s' };
    if (tok.startsWith('-')) return { kind: 'refuse', why: 'a flag before the verb is refused' };
    return { kind: 'cmd', serial, verb: tok, rest: args.slice(i + 1) };
  }
  return { kind: 'refuse', why: 'the command has no verb' };
}

/**
 * A tap, a key or typed text is one shell string: check the focus, then run the command.
 * shellKind refuses that whole string and allows the command inside it. The lane allows the string
 * only when the command inside is one shellKind already allows in that place.
 */
function phoneShellOk(command: string): boolean {
  if (command === FOCUS_READ || command === DUMP_COMMAND) return true;
  const kind = shellKind(command);
  if (kind === 'read' || kind === 'anywhere') return true;
  const inner = envelopeOf(command);
  if (inner === undefined) return false;
  const innerKind = shellKind(inner.command);
  return inner.allowPrompt ? innerKind === 'in-app-or-prompt' : innerKind === 'in-app';
}

/** On the tablet a command on the Tests list may run bare or inside the steps' in-app check. */
function tabletShellOk(command: string): boolean {
  if (command === FOCUS_READ || command === DUMP_COMMAND) return true;
  if (testsShellKind(command) !== 'refused') return true;
  const inner = envelopeOf(command);
  return inner !== undefined && testsShellKind(inner.command) !== 'refused';
}

const isApk = (apk: string | undefined): boolean => apk !== undefined && !apk.startsWith('-') && /[^\\/]\.apk$/i.test(apk);

/** `install -r --user <user> <x.apk>`, and nothing else: an install always names the one user it is for. */
function installFor(user: number, rest: readonly string[]): boolean {
  return rest.length === 4 && rest[0] === '-r' && rest[1] === '--user' && rest[2] === String(user) && isApk(rest[3]);
}

function installOk(verb: string, rest: readonly string[]): AdbVerdict {
  if (verb === 'install') {
    if (rest.includes('-d')) return { ok: false, why: 'install never passes -d' };
    if (installFor(0, rest)) return { ok: true };
    return { ok: false, why: 'install may only install -r --user 0 the apk' };
  }
  if (verb === 'shell' && rest.length === 3 && rest[0] === 'dumpsys' && rest[1] === 'package' && rest[2] === RELEASE_ID) {
    return { ok: true };
  }
  return { ok: false, why: 'install may only install -r or read the version' };
}

function phoneOk(verb: string, rest: readonly string[]): AdbVerdict {
  if (verb === 'push') {
    const local = rest[0];
    const remote = rest[1];
    if (rest.length === 2 && local !== undefined && local !== '' && !local.startsWith('-') && remote === LONG_REMOTE) {
      return { ok: true };
    }
    return { ok: false, why: 'the push must be the invented file' };
  }
  if (verb === 'shell') {
    const command = rest[0];
    if (rest.length !== 1 || command === undefined) return { ok: false, why: 'shell takes one command' };
    if (!phoneShellOk(command)) return { ok: false, why: 'that shell command is refused' };
    return { ok: true };
  }
  return { ok: false, why: 'the phone checks may only push the invented file or send a guarded command' };
}

function tabletOk(serial: string, verb: string, rest: readonly string[]): AdbVerdict {
  if (serial.startsWith('emulator-')) return { ok: false, why: 'an emulator is not the tablet' };
  if (verb === 'install') {
    if (rest.includes('-d')) return { ok: false, why: 'install never passes -d' };
    if (installFor(TESTS_USER, rest) && (rest[3] ?? '').split(/[\\/]/).pop() === TESTS_APK_NAME) return { ok: true };
    return { ok: false, why: `the tablet may only install -r --user 10 the tests build (${TESTS_APK_NAME})` };
  }
  if (verb === 'push') {
    const local = rest[0];
    // the shell's own folder; from there it goes into the Tests user's Downloads through that user's media library
    if (rest.length === 2 && local !== undefined && local !== '' && !local.startsWith('-') && rest[1] === TESTS_LONG_TMP) return { ok: true };
    return { ok: false, why: 'the push must be the invented file, to the shell\'s folder on its way to the Tests user\'s storage' };
  }
  if (verb === 'shell') {
    const command = rest[0];
    if (rest.length !== 1 || command === undefined) return { ok: false, why: 'shell takes one command' };
    if (command === `dumpsys package ${TESTS_ID}`) return { ok: true };
    if (!tabletShellOk(command)) return { ok: false, why: 'that shell command is refused on the tablet' };
    return { ok: true };
  }
  if (verb === 'exec-out') {
    // the stand-in's screenshots, inside the Tests user only (allowed 15 Nov)
    if (rest.length === 1 && rest[0] === 'screencap') return { ok: true };
    return { ok: false, why: 'the tablet\'s exec-out is only screencap' };
  }
  return { ok: false, why: 'the tablet may only install in the Tests user, push the invented file or send a guarded command' };
}

/** Whether this lane may run this adb argument list. No I/O. */
export function adbVerdict(lane: Lane, args: readonly string[]): AdbVerdict {
  const head = headOf(args);
  if (head.kind === 'devices') return { ok: true };
  if (head.kind === 'refuse') return { ok: false, why: head.why };
  if (head.kind === 'second-s') return { ok: false, why: lane === 'emulator' ? EMULATOR_ONLY : 'a second -s is refused' };
  if (lane === 'emulator') return head.serial === EMULATOR_SERIAL ? { ok: true } : { ok: false, why: EMULATOR_ONLY };
  if (lane === 'install') return installOk(head.verb, head.rest);
  if (lane === 'tablet') return tabletOk(head.serial, head.verb, head.rest);
  return phoneOk(head.verb, head.rest);
}

export interface AdbRun {
  readonly status: number | null;
  readonly out: string;
  readonly stdout: Uint8Array;
}

interface SpawnOpts {
  readonly env: NodeJS.ProcessEnv;
  readonly windowsHide: true;
  readonly timeout: number;
  readonly maxBuffer?: number;
  readonly encoding?: 'utf8';
  stdio?: ['ignore', number, 'ignore'];
}

export interface AdbSpawnResult {
  readonly status: number | null;
  readonly stdout?: string | Buffer | null;
  readonly stderr?: string | Buffer | null;
}

/** Test seam. Production callers leave it unset, and the real tool is started. */
export type AdbSpawn = (file: string, args: readonly string[], opts: SpawnOpts) => AdbSpawnResult;

export interface RunAdbOptions {
  readonly timeoutMs?: number;
  readonly maxBuffer?: number;
  /** Text mode joins stdout and stderr. Omit it to keep stdout bytes. */
  readonly encoding?: 'utf8';
  /** Write stdout to this file. The file is opened only after the verdict allows the command. */
  readonly captureTo?: string;
  readonly spawn?: AdbSpawn;
}

function asText(v: string | Buffer | null | undefined): string {
  if (v == null) return '';
  return typeof v === 'string' ? v : v.toString('utf8');
}

function asBytes(v: string | Buffer | null | undefined): Uint8Array {
  if (typeof v === 'string') return new Uint8Array(Buffer.from(v));
  if (Buffer.isBuffer(v)) return new Uint8Array(v);
  return new Uint8Array();
}

/**
 * The tablet lane's run-time half, after the verdict. A shell command goes inside the Tests-user check, so the
 * check and the command are one call on the tablet. An install or a push is not a shell command: the current
 * user is read first. Nothing of the owner's account is read. Anything the gate can't confirm stops the command.
 */
function tabletArgs(args: readonly string[], read: (args: readonly string[]) => AdbSpawnResult): readonly string[] {
  const head = headOf(args);
  if (head.kind !== 'cmd') return args;
  const at = (rest: readonly string[]) => ['-s', head.serial, ...rest];
  if (head.verb === 'shell') return at(['shell', inTestsUser(head.rest[0] ?? '')]);
  if (head.verb === 'exec-out') return at(['exec-out', inTestsUser(head.rest.join(' '))]);
  const user = read(at(['shell', 'am get-current-user']));
  if (user.status !== 0 || asText(user.stdout).trim() !== String(TESTS_USER)) throw new NotTestsUser();
  return args;
}

/** Runs one adb command on a lane. A refused command throws `Refused` and starts nothing. */
export function runAdb(lane: Lane, args: readonly string[], opts: RunAdbOptions = {}): AdbRun {
  const verdict = adbVerdict(lane, args);
  if (!verdict.ok) throw new Refused(verdict.why);
  if (lane === 'tablet' && opts.captureTo !== undefined) throw new Refused('the tablet lane captures nothing to a file');
  const timeout = opts.timeoutMs ?? 60_000;
  const injected = opts.spawn;
  let file: string;
  let env: NodeJS.ProcessEnv;
  if (injected !== undefined) {
    file = 'adb';
    env = process.env;
  } else {
    const tc = toolchain(process.env);
    file = toolPaths(tc).adb;
    env = childEnv(tc, process.env);
  }
  const spawn = injected ?? ((bin, argv, o) => spawnSync(bin, [...argv], o));
  if (lane === 'tablet') {
    const sent = tabletArgs(args, a => spawn(file, a, { env, windowsHide: true, timeout: 30_000, encoding: 'utf8' }));
    if (sent.includes('exec-out')) {
      const shot = spawn(file, sent, { env, windowsHide: true, timeout, maxBuffer: opts.maxBuffer ?? 64 * 1024 * 1024 });
      const bytes = asBytes(shot.stdout);
      if (Buffer.from(bytes.subarray(0, 64)).toString('latin1').includes(NOT_TESTS_USER)) throw new NotTestsUser();
      return { status: shot.status, out: '', stdout: bytes };
    }
    const ran = spawn(file, sent, {
      env, windowsHide: true, timeout, encoding: 'utf8', ...(opts.maxBuffer !== undefined ? { maxBuffer: opts.maxBuffer } : {}),
    });
    const out = `${asText(ran.stdout)}${asText(ran.stderr)}`;
    if (out.includes(NOT_TESTS_USER)) throw new NotTestsUser();
    return { status: ran.status, out, stdout: new Uint8Array() };
  }
  if (opts.captureTo !== undefined) {
    const fd = openSync(opts.captureTo, 'w');
    try {
      const ran = spawn(file, args, { env, windowsHide: true, timeout, stdio: ['ignore', fd, 'ignore'] });
      return { status: ran.status, out: '', stdout: new Uint8Array() };
    } finally {
      closeSync(fd);
    }
  }
  const base = {
    env,
    windowsHide: true as const,
    timeout,
    ...(opts.maxBuffer !== undefined ? { maxBuffer: opts.maxBuffer } : {}),
  };
  if (opts.encoding === 'utf8') {
    const ran = spawn(file, args, { ...base, encoding: 'utf8' });
    return { status: ran.status, out: `${asText(ran.stdout)}${asText(ran.stderr)}`, stdout: new Uint8Array() };
  }
  const ran = spawn(file, args, base);
  return { status: ran.status, out: '', stdout: asBytes(ran.stdout) };
}
