// The test phone on the emulator, behind the memory gate. Only a dc- test phone, on its own port
// (another project uses 5554), with no snapshot, no window, a software GPU and 3 GB. It is started
// detached and always stopped by the caller; nothing is left running.
// node scripts/android/emulator.ts start|stop
import { spawn, spawnSync } from 'node:child_process';
import { closeSync, mkdirSync, openSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { childEnv, toolchain, toolPaths } from './env.ts';
import { readHeavy, waitForRoom } from './memory.ts';

export const PORT = 5556;
export const SERIAL = 'emulator-5556';
export const AVD = 'dc-api33';

const BOOT_WAIT_MS = 5 * 60_000;
const STOP_WAIT_MS = 60_000;
const POLL_MS = 5_000;
const LOG_DIR = join('.local', 'logs');

/** The emulator's arguments: its own port, no snapshot, no window, a software GPU, 3 GB. Only a dc- test phone. */
export function emulatorArgs(avd: string): string[] {
  if (!avd.startsWith('dc-')) throw new Error('emulator: only a dc- test phone may be started');
  return ['-avd', avd, '-port', String(PORT), '-memory', '3072', '-no-snapshot',
    '-no-boot-anim', '-no-audio', '-no-window', '-gpu', 'swiftshader_indirect'];
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

function listed(): boolean {
  return adb(['devices']).out.split(/\r?\n/).some(l => l.startsWith(`${SERIAL}\t`) || l.startsWith(`${SERIAL} `));
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
  closeSync(fd);
  let exited: number | null = null;
  child.on('error', () => {});
  child.on('exit', code => { exited = code ?? -1; });
  child.unref();
  adb(['-s', SERIAL, 'wait-for-device'], BOOT_WAIT_MS);
  if (listed()) console.log(`emulator: listed by adb after ${seconds()} s`);
  while (Date.now() - started < BOOT_WAIT_MS) {
    if (exited !== null) break;
    if (adb(['-s', SERIAL, 'shell', 'getprop', 'sys.boot_completed'], 30_000).out.trim() === '1') {
      console.log(`emulator: booted in ${seconds()} s`);
      return true;
    }
    await sleep(POLL_MS);
  }
  const where = exited !== null ? `the emulator exited (code ${exited}) after ${seconds()} s`
    : !listed() ? 'adb never listed it'
    : `listed, boot animation ${adb(['-s', SERIAL, 'shell', 'getprop', 'init.svc.bootanim'], 30_000).out.trim() || 'unknown'}`;
  console.log(`emulator: did not finish booting in 5 minutes (${where}); its output: ${log.split('\\').join('/')}`);
  await stopEmulator();
  return false;
}

/** adb -s emulator-5556 emu kill, then waits until adb no longer lists it and no emulator process is left. */
export async function stopEmulator(): Promise<void> {
  adb(['-s', SERIAL, 'emu', 'kill'], 30_000);
  const since = Date.now();
  while (Date.now() - since < STOP_WAIT_MS) {
    if (!listed() && readHeavy().emulators === 0) {
      console.log('emulator: stopped');
      return;
    }
    await sleep(2_000);
  }
  console.log(`emulator: ${listed() ? 'still listed' : 'its process still running'} 60 s after the stop`);
}

if (import.meta.main) {
  const what = process.argv[2];
  if (what === 'start') process.exitCode = (await startEmulator()) ? 0 : 1;
  else if (what === 'stop') await stopEmulator();
  else {
    console.log('usage: node scripts/android/emulator.ts start|stop');
    process.exitCode = 2;
  }
}
