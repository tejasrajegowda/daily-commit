// The memory gate. This PC is short of memory and another Android project may build on it too, so a
// Gradle build or an emulator starts only when nothing else heavy is running (in any project) and
// enough memory is free. It waits and re-checks; it never stops, suspends or signals anything.
// It prints counts and amounts only, never a process's command line.
import { readFileSync } from 'node:fs';
import { freemem } from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';
import { runSync } from './proc.ts';

export const GB = 1024 ** 3;
// Gradle here runs at -Xmx2g with no daemon and Kotlin in-process, so it peaks near 3 GB: 4 GB free leaves a 1 GB margin.
export const NEED_FREE_GRADLE = 4 * GB;
export const NEED_FREE_EMULATOR = 6 * GB;     // the N2 bar

const CHECK_EVERY_MS = 30_000;
const SAY_EVERY_MS = 60_000;
const GIVE_UP_MS = 30 * 60_000;

export interface Heavy { readonly freeBytes: number; readonly gradleBuilds: number; readonly emulators: number }
export interface ProcessRow { readonly name: string; readonly commandLine: string }

const GRADLE_BUILD = /GradleWrapperMain|gradle-wrapper\.jar|KotlinCompileDaemon/;

/** A running Gradle client (any project) or Kotlin daemon counts as a build; an idle Gradle daemon counts only through free memory. */
export function countHeavy(rows: readonly ProcessRow[]): { gradleBuilds: number; emulators: number } {
  let gradleBuilds = 0;
  let emulators = 0;
  for (const row of rows) {
    const name = row.name.toLowerCase();
    if ((name === 'java.exe' || name === 'javaw.exe' || name === 'java' || name === 'javaw') && GRADLE_BUILD.test(row.commandLine)) gradleBuilds++;
    else if (name.startsWith('qemu-system-') || name === 'emulator.exe') emulators++;
  }
  return { gradleBuilds, emulators };
}

export function mayStart(kind: 'gradle' | 'emulator', h: Heavy): { readonly ok: true } | { readonly ok: false; readonly why: string } {
  const reasons: string[] = [];
  const need = kind === 'gradle' ? NEED_FREE_GRADLE : NEED_FREE_EMULATOR;
  if (h.freeBytes < need) reasons.push(`${(h.freeBytes / GB).toFixed(1)} GB free (${need / GB} needed)`);
  if (h.gradleBuilds > 0) reasons.push(`${h.gradleBuilds} other build${h.gradleBuilds === 1 ? '' : 's'} running`);
  if (h.emulators > 0) reasons.push(`${h.emulators} emulator${h.emulators === 1 ? '' : 's'} running`);
  return reasons.length === 0 ? { ok: true } : { ok: false, why: `${kind} waits, ${reasons.join(', ')}` };
}

/** Reads the PC now (os.freemem and one CIM query); prints nothing. */
export function readHeavy(): Heavy {
  const query = "Get-CimInstance Win32_Process -Filter \"Name='java.exe' or Name='javaw.exe' or Name='qemu-system-x86_64.exe' or Name='emulator.exe'\" | Select-Object Name,CommandLine | ConvertTo-Json -Compress";
  const r = runSync('powershell', ['-NoProfile', '-Command', query], { encoding: 'utf8', windowsHide: true });
  const text = String(r.stdout ?? '').trim();
  let rows: ProcessRow[] = [];
  if (r.status === 0 && text) {
    const parsed: unknown = JSON.parse(text);
    const list = Array.isArray(parsed) ? parsed : [parsed];
    rows = list.map((p: { Name?: unknown; CommandLine?: unknown }) => ({
      name: typeof p.Name === 'string' ? p.Name : '',
      commandLine: typeof p.CommandLine === 'string' ? p.CommandLine : '',
    }));
  } else if (r.status !== 0) {
    throw new Error('memory gate: the process query failed');
  }
  return { freeBytes: freemem(), ...countHeavy(rows) };
}

/**
 * Whether the PC's shared RAM budget (a JSON file kept by the machine's own slot script, outside this repo) already
 * grants this job's owner a slot of this kind. That script measures and reserves memory across every project, so a
 * held grant is the answer; this gate's own bar applies only when no grant is held. Kinds there: build, emulator.
 */
export function grantCovers(kind: 'gradle' | 'emulator', budgetText: string, ownerPid: number): boolean {
  if (!Number.isInteger(ownerPid) || ownerPid <= 0) return false;
  let parsed: unknown;
  try { parsed = JSON.parse(budgetText); } catch { return false; }
  const grants = typeof parsed === 'object' && parsed !== null && 'grants' in parsed && Array.isArray(parsed.grants) ? parsed.grants : [];
  const want = kind === 'gradle' ? 'build' : 'emulator';
  return grants.some((g: unknown) => typeof g === 'object' && g !== null
    && 'pid' in g && g.pid === ownerPid && 'kind' in g && g.kind === want);
}

/** The grant named by DC_RAM_BUDGET (the budget file) and DC_RAM_OWNER_PID (who holds it); false when either is unset or unreadable. */
function machineGrant(kind: 'gradle' | 'emulator'): boolean {
  const file = process.env.DC_RAM_BUDGET;
  const pid = Number(process.env.DC_RAM_OWNER_PID);
  if (!file) return false;
  try { return grantCovers(kind, readFileSync(file, 'utf8'), pid); } catch { return false; }
}

/** Waits until mayStart says yes, or at once when the machine's slot script already grants this job: re-checks every 30 s, one line a minute (counts only), gives up after 30 minutes. */
export async function waitForRoom(kind: 'gradle' | 'emulator'): Promise<boolean> {
  if (machineGrant(kind)) {
    console.log(`memory gate: the machine's ${kind === 'gradle' ? 'build' : 'emulator'} slot is held for this job`);
    return true;
  }
  const start = Date.now();
  let lastSaid = -Infinity;
  for (;;) {
    const verdict = mayStart(kind, readHeavy());
    if (verdict.ok) return true;
    const now = Date.now();
    if (now - start >= GIVE_UP_MS) {
      console.log(`memory gate: gave up after 30 minutes (${verdict.why})`);
      return false;
    }
    if (now - lastSaid >= SAY_EVERY_MS) {
      console.log(`memory gate: ${verdict.why}; checking again every 30 s`);
      lastSaid = now;
    }
    await sleep(CHECK_EVERY_MS);
  }
}
