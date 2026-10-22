// The only place under scripts/android that starts adb. The verdict is pure: a refused command throws
// before the tool path is looked up and before any process is started.
import { spawnSync } from 'node:child_process';
import { closeSync, openSync } from 'node:fs';
import { APP_ID } from './apk-check.ts';
import {
  DUMP_COMMAND, FOCUS_READ, LONG_REMOTE, Refused, envelopeOf, shellKind,
} from './checks/shellAllow.ts';
import { childEnv, toolchain, toolPaths } from './env.ts';

export type Lane = 'install' | 'phoneChecks' | 'emulator';

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

function installOk(verb: string, rest: readonly string[]): AdbVerdict {
  if (verb === 'install') {
    if (rest.includes('-d')) return { ok: false, why: 'install never passes -d' };
    const apk = rest.length === 2 && rest[0] === '-r' ? rest[1] : undefined;
    if (apk !== undefined && !apk.startsWith('-') && /[^\\/]\.apk$/i.test(apk)) return { ok: true };
    return { ok: false, why: 'install may only install -r the apk' };
  }
  if (verb === 'shell' && rest.length === 3 && rest[0] === 'dumpsys' && rest[1] === 'package' && rest[2] === APP_ID) {
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

/** Whether this lane may run this adb argument list. No I/O. */
export function adbVerdict(lane: Lane, args: readonly string[]): AdbVerdict {
  const head = headOf(args);
  if (head.kind === 'devices') return { ok: true };
  if (head.kind === 'refuse') return { ok: false, why: head.why };
  if (head.kind === 'second-s') return { ok: false, why: lane === 'emulator' ? EMULATOR_ONLY : 'a second -s is refused' };
  if (lane === 'emulator') return head.serial === EMULATOR_SERIAL ? { ok: true } : { ok: false, why: EMULATOR_ONLY };
  if (lane === 'install') return installOk(head.verb, head.rest);
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

/** Runs one adb command on a lane. A refused command throws `Refused` and starts nothing. */
export function runAdb(lane: Lane, args: readonly string[], opts: RunAdbOptions = {}): AdbRun {
  const verdict = adbVerdict(lane, args);
  if (!verdict.ok) throw new Refused(verdict.why);
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
