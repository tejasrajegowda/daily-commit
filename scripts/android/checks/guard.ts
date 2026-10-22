// The privacy guard for driving a real phone. Every read and every tap first checks that Daily Commit
// is the focused window; anything else stops the step with "not in the app" and nothing is read.
// The phone checks the focus again in the same call, right before it taps or reads, so an app that
// comes up in between is never tapped or read.
// Only nodes of Daily Commit's own package leave a screen dump. The shell takes a short list of
// commands and refuses the rest, so a screenshot, a recording, another app's data or a wipe can't be
// sent by mistake. An emulator is never the phone; the dry run names emulator-5556 on purpose.
import { nodesOf, type DeviceIo, type UiNode } from '../drive.ts';
import { devicesOf } from '../phone.ts';
import { EMULATOR_SERIAL, runAdb } from '../adbGate.ts';
import {
  APP, DUMP_COMMAND, FOCUS_READ, LONG_REMOTE, NOT_FRONT,
  Refused, onlyInFront, shellKind,
} from './shellAllow.ts';

export {
  APP, DUMP_COMMAND, FOCUS_READ, LONG_REMOTE, NOT_FRONT, SCAN_LONG,
  Refused, envelopeOf, onlyInFront, shellKind,
} from './shellAllow.ts';
export type { ShellKind } from './shellAllow.ts';

export const DRY_RUN_SERIAL = EMULATOR_SERIAL;
export const NOT_IN_APP = 'not in the app';

/** The step stops here. Its message is the whole of what is said. */
export class NotInApp extends Error {
  constructor() {
    super(NOT_IN_APP);
    this.name = 'NotInApp';
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

export type Adb = (args: readonly string[], timeoutMs?: number) => { readonly code: number; readonly out: string };

export interface GuardedPhone extends DeviceIo {
  readonly serial: string;
  /** Who has the focus now. Never printed beyond these three words. */
  front(): Front;
  /** Copies the invented long record to the phone's Download folder. */
  pushLong(localPath: string): boolean;
}

/** The text between `<hierarchy` and `</hierarchy>` of a uiautomator dump, or '' when there is none. */
export function hierarchyOf(out: string): string {
  const start = out.indexOf('<hierarchy');
  const end = out.lastIndexOf('</hierarchy>');
  return start >= 0 && end > start ? out.slice(start, end + '</hierarchy>'.length) : '';
}

/** The phone-checks lane. A caller that passes its own executor (the tests) does not come through here. */
export function phoneChecksAdb(args: readonly string[], timeoutMs = 60_000): { readonly code: number; readonly out: string } {
  const ran = runAdb('phoneChecks', args, { timeoutMs, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  return { code: ran.status ?? 1, out: ran.out };
}

/**
 * The phone, through the guard. `serial` must be a real phone; only `dryRun` lets emulator-5556 stand in.
 * Nothing here prints; a caller sees only the nodes of Daily Commit and the three words of `front()`.
 */
export function guardedPhone(serial: string, adb: Adb = phoneChecksAdb, opts: { readonly dryRun?: boolean } = {}): GuardedPhone {
  if (serial.startsWith('emulator-') && !(opts.dryRun === true && serial === DRY_RUN_SERIAL)) {
    throw new Refused('an emulator is not the phone');
  }
  if (opts.dryRun === true && serial !== DRY_RUN_SERIAL) throw new Refused('the dry run uses only emulator-5556');
  // adb names the serial in its own errors ("device '…' not found"); it is cut out here, so no error line carries it.
  const run = (args: readonly string[], timeoutMs?: number) => {
    const r = adb(['-s', serial, ...args], timeoutMs);
    return { code: r.code, out: r.out.split(serial).join('the phone') };
  };
  const front = (): Front => frontOf(run(['shell', FOCUS_READ], 20_000).out);
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
