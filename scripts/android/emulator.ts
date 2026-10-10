// The test phone on the emulator, behind the memory gate. Only a dc- test phone, on its own port
// (another project uses 5554), with no snapshot, no window, a software GPU and 3 GB. It is started
// detached. Stopping it talks to emulator-5556, then stops only the process this script started.
// node scripts/android/emulator.ts start|stop
import { spawn, spawnSync } from 'node:child_process';
import { closeSync, mkdirSync, openSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { childEnv, toolchain, toolPaths } from './env.ts';
import { waitForRoom } from './memory.ts';

export const PORT = 5556;
export const SERIAL = 'emulator-5556';
export const AVD = 'dc-api33';

const BOOT_WAIT_MS = 5 * 60_000;
const STOP_WAIT_MS = 60_000;
const POLL_MS = 5_000;
const LOG_DIR = join('.local', 'logs');

/** The emulator process this script started. Absent when this script did not start one. */
let emulatorPid: number | undefined;
let stopSignalsArmed = false;
let stopInFlight: Promise<boolean> | undefined;
let interruptExit = false;

/** True only when emulator-5556 is not listed and the process this script started is gone. */
export function emulatorStopped(state: { readonly serialListed: boolean; readonly ourPidAlive: boolean }): boolean {
  return !state.serialListed && !state.ourPidAlive;
}

/** The process tree is stopped only for a pid this script stored, and only while that pid is alive. */
export function shouldStopProcessTree(state: { readonly pid: number | undefined; readonly alive: boolean }): boolean {
  return state.pid !== undefined && state.alive;
}

/** taskkill of one pid and its children. An argument list, never a shell command. */
export function taskkillArgs(pid: number): string[] {
  return ['/PID', String(pid), '/T', '/F'];
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return typeof err === 'object' && err !== null && 'code' in err && err.code === 'EPERM';
  }
}

/** True while the stored pid exists. A dead pid is forgotten so a later stop cannot hit a recycled one. */
function ourPidAlive(): boolean {
  const pid = emulatorPid;
  if (pid === undefined) return false;
  if (pidAlive(pid)) return true;
  emulatorPid = undefined;
  return false;
}

function armStopSignals(): void {
  if (stopSignalsArmed) return;
  process.on('SIGINT', onStopSignal);
  process.on('SIGTERM', onStopSignal);
  stopSignalsArmed = true;
}

function disarmStopSignals(): void {
  if (!stopSignalsArmed) return;
  process.off('SIGINT', onStopSignal);
  process.off('SIGTERM', onStopSignal);
  stopSignalsArmed = false;
}

function onStopSignal(): void {
  if (interruptExit) return;
  interruptExit = true;
  void stopEmulator().finally(() => {
    process.exit(130);
  });
}

function tools(): { adb: string; emulator: string; env: Record<string, string> } {
  const tc = toolchain(process.env);
  const paths = toolPaths(tc);
  return { adb: paths.adb, emulator: paths.emulator, env: childEnv(tc, process.env) };
}

/** One adb command on the test phone (or on adb itself with no serial); its output, never printed here. */
export function adb(args: readonly string[], timeoutMs = 120_000): { status: number; out: string } {
  const { adb: tool, env } = tools();
  const r = spawnSync(tool, args, { encoding: 'utf8', env, windowsHide: true, timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 });
  return { status: r.status ?? 1, out: (r.stdout ?? '') + (r.stderr ?? '') };
}

function listed(timeoutMs?: number): boolean {
  return adb(['devices'], timeoutMs).out.split(/\r?\n/).some(l => l.startsWith(`${SERIAL}\t`) || l.startsWith(`${SERIAL} `));
}

/** Starts it behind the memory gate ('emulator') and waits for sys.boot_completed (5 minutes at most). */
export async function startEmulator(avd: string = AVD): Promise<boolean> {
  const args = emulatorArgs(avd);
  if (!(await waitForRoom('emulator'))) return false;
  const { emulator, env } = tools();
  // The emulator's own output goes to an ignored log, so a boot that stalls can be read afterwards.
  mkdirSync(LOG_DIR, { recursive: true });
  const now = new Date(Date.now() - new Date().getTimezoneOffset() * 60_000);   // local time, like the other logs
  const log = join(LOG_DIR, `emulator-${now.toISOString().replace(/\D/g, '').slice(0, 14)}.log`);
  const fd = openSync(log, 'w');
  const started = Date.now();
  const seconds = () => ((Date.now() - started) / 1000).toFixed(0);
  const child = spawn(emulator, args, { detached: true, stdio: ['ignore', fd, fd], env, windowsHide: true });
  let exited: number | null = null;
  child.on('error', () => { if (exited === null) exited = -1; });
  child.on('exit', code => { exited = code ?? exited ?? -1; });
  closeSync(fd);
  if (typeof child.pid === 'number') {
    emulatorPid = child.pid;
    armStopSignals();
  }
  child.unref();
  // Poll the boot property. A five-minute wait-for-device would hide a child that has already exited.
  const childGone = async (): Promise<boolean> => {
    await sleep(0);
    if (exited === null && child.exitCode !== null) exited = child.exitCode;
    return exited !== null;
  };
  let announced = false;
  while (Date.now() - started < BOOT_WAIT_MS) {
    if (await childGone()) break;
    if (!announced && listed(POLL_MS)) {
      console.log(`emulator: listed by adb after ${seconds()} s`);
      announced = true;
    }
    if (await childGone()) break;
    const polledAt = Date.now();
    const boot = adb(['-s', SERIAL, 'shell', 'getprop', 'sys.boot_completed'], POLL_MS);
    if (await childGone()) break;
    if (boot.out.trim() === '1') {
      console.log(`emulator: booted in ${seconds()} s`);
      return true;
    }
    const left = POLL_MS - (Date.now() - polledAt);
    if (left > 0) await sleep(left);
  }
  const where = exited !== null ? `the emulator exited (code ${exited}) after ${seconds()} s`
    : !listed() ? 'adb never listed it'
    : `listed, boot animation ${adb(['-s', SERIAL, 'shell', 'getprop', 'init.svc.bootanim'], 30_000).out.trim() || 'unknown'}`;
  console.log(`emulator: did not finish booting in 5 minutes (${where}); its output: ${log.split('\\').join('/')}`);
  await stopEmulator();
  return false;
}

async function waitUntilOursGone(): Promise<boolean> {
  const since = Date.now();
  for (;;) {
    if (emulatorStopped({ serialListed: listed(), ourPidAlive: ourPidAlive() })) return true;
    if (Date.now() - since >= STOP_WAIT_MS) return false;
    await sleep(2_000);
  }
}

function stopOurProcessTree(): void {
  const pid = emulatorPid;
  const alive = pid !== undefined && pidAlive(pid);
  if (pid === undefined || !shouldStopProcessTree({ pid, alive })) return;
  console.log('emulator: stopping the process this script started');
  spawnSync('taskkill', taskkillArgs(pid), { shell: false, windowsHide: true, stdio: 'ignore', timeout: 30_000 });
}

/** adb -s emulator-5556 emu kill, then up to 60 s. If the process this script started is still alive, stops that process tree only. */
export async function stopEmulator(): Promise<boolean> {
  if (stopInFlight) return stopInFlight;
  stopInFlight = stopEmulatorOnce();
  try {
    return await stopInFlight;
  } finally {
    stopInFlight = undefined;
  }
}

async function stopEmulatorOnce(): Promise<boolean> {
  adb(['-s', SERIAL, 'emu', 'kill'], 30_000);
  if (!(await waitUntilOursGone())) stopOurProcessTree();
  const gone = await waitUntilOursGone();
  if (gone) {
    console.log('emulator: stopped');
    disarmStopSignals();
    return true;
  }
  console.log(`emulator: ${listed() ? 'still listed' : 'its process still running'} 60 s after the stop`);
  return false;
}

/** The emulator's arguments: its own port, no snapshot, no window, a software GPU, 3 GB. Only a dc- test phone. */
export function emulatorArgs(avd: string): string[] {
  if (!avd.startsWith('dc-')) throw new Error('emulator: only a dc- test phone may be started');
  return ['-avd', avd, '-port', String(PORT), '-memory', '3072', '-no-snapshot',
    '-no-boot-anim', '-no-audio', '-no-window', '-gpu', 'swiftshader_indirect'];
}

if (import.meta.main) {
  const what = process.argv[2];
  if (what === 'start') process.exitCode = (await startEmulator()) ? 0 : 1;
  else if (what === 'stop') process.exitCode = (await stopEmulator()) ? 0 : 1;
  else {
    console.log('usage: node scripts/android/emulator.ts start|stop');
    process.exitCode = 2;
  }
}
