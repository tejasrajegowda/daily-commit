// Task 8a on the test phone. One process holds the emulator for the whole run.
// 8b is a later task. adb is only ever aimed at emulator-5556.
import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { freemem } from 'node:os';
import { join } from 'node:path';
import { adbOnTestPhone, emu, pause, type Emu } from '../drive.ts';
import { childEnv, toolchain, toolPaths } from '../env.ts';
import { startEmulator, stopEmulator } from '../emulator.ts';
import { GB } from '../memory.ts';
import { isDcTestPhone } from '../smoke.ts';
import { checksA, Platform, type RunCtx } from './a.ts';
import { seed, type Seed } from './seed.ts';

const NAMES = ['A0', 'A1', 'A2', 'A3', 'A4', 'A5', 'A6', 'A7', 'A8', 'A9', 'A10', 'A11', 'A12', 'A13', 'A14', 'A15', 'A16', 'A17', 'A18', 'A19'] as const;
const CUE_FILE = join('.local', 'android', '8a-cues.json');

function stamp(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function minuteOf(sec: number): number {
  return Math.floor((sec % 86400) / 60);
}

/** 23:59 is the only quiet minute with this record's lights-out. A cue never lands there. */
function awayFromQuiet(minute: number): number {
  const m = ((minute % 1440) + 1440) % 1440;
  return m === 1439 ? 0 : m;
}

function farCues(sec: number): { shown: number; private: number } {
  const shown = awayFromQuiet(minuteOf(sec) + 180);
  const priv = awayFromQuiet(shown + 2);
  return { shown, private: priv === shown ? awayFromQuiet(shown + 3) : priv };
}

function deviceSec(phone: Emu): number {
  const sec = Number(phone.shell('date +%s').out.trim());
  if (!Number.isFinite(sec) || sec <= 0) throw new Error('the phone clock could not be read');
  return sec;
}

function readCues(): { shown: number; private: number; seededAtSec: number } | undefined {
  if (!existsSync(CUE_FILE)) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(CUE_FILE, 'utf8'));
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined;
  const row = parsed as { shown?: unknown; private?: unknown; seededAtSec?: unknown };
  if (typeof row.shown !== 'number' || typeof row.private !== 'number' || typeof row.seededAtSec !== 'number') return undefined;
  return { shown: row.shown, private: row.private, seededAtSec: row.seededAtSec };
}

function remember(cues: { shown: number; private: number }, seededAtSec: number): void {
  mkdirSync(join('.local', 'android'), { recursive: true });
  writeFileSync(CUE_FILE, `${JSON.stringify({ shown: cues.shown, private: cues.private, seededAtSec })}\n`);
}

function refused(argv: readonly string[]): boolean {
  return argv.some(a => a.includes('5554') || (/emulator-\d+/.test(a) && !a.includes('emulator-5556')));
}

function avdListed(name: string): boolean {
  const tc = toolchain(process.env);
  const listed = spawnSync(toolPaths(tc).emulator, ['-list-avds'], {
    encoding: 'utf8', env: childEnv(tc, process.env), windowsHide: true, timeout: 60_000,
  });
  return `${listed.stdout ?? ''}${listed.stderr ?? ''}`.split(/\r?\n/).some(line => line.trim() === name);
}

function installApp(): string {
  const ran = spawnSync('npm', ['run', 'phone', '--', '--serial', 'emulator-5556'], {
    shell: true, encoding: 'utf8', windowsHide: true, timeout: 300_000, cwd: process.cwd(),
  });
  return `${ran.stdout ?? ''}${ran.stderr ?? ''}`;
}

function resetPhone(): void {
  let named: { code: number; out: string };
  try {
    named = adbOnTestPhone(['emu', 'avd', 'name'], 30_000);
  } catch {
    return;
  }
  if (named.code !== 0 || !isDcTestPhone(named.out)) return;
  const sh = (command: string) => {
    try {
      adbOnTestPhone(['shell', command], 30_000);
    } catch {
      // The phone may already be gone.
    }
  };
  sh('settings put global airplane_mode_on 0');
  sh('cmd connectivity airplane-mode disable');
  sh('dumpsys deviceidle unforce');
  sh('dumpsys battery reset');
  sh('settings put global always_finish_activities 0');
  sh('locksettings clear --old 1111');
  sh('rm -f /data/local/tmp/dc-fill /data/user/0/app.dailycommit/dc-fill');
}

/** Shown is six minutes ahead and the private cue eight. Past 23:51 UTC, wait until 00:02. */
async function cueClock(phone: Emu, say: (line: string) => void): Promise<number> {
  let sec = deviceSec(phone);
  if (minuteOf(sec) < 1431) return sec;
  const waitSec = (86400 - (sec % 86400)) + 120;
  say(`cue minute would fall on the quiet minute; waiting ${waitSec} s until 00:02 UTC`);
  pause(waitSec * 1000);
  sec = deviceSec(phone);
  if (minuteOf(sec) >= 1431) throw new Error('the phone clock is still in the quiet window');
  return sec;
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  if (refused(argv)) {
    console.log('refusing: adb may address only emulator-5556');
    return 2;
  }
  if (argv[0] === '8b') {
    console.log('8b is written in Task 8b.');
    return 2;
  }
  if (argv[0] !== '8a') {
    console.log('usage: node scripts/android/checks/run.ts 8a [--from A0]');
    return 2;
  }
  const rest = argv.slice(1);
  let from: string | undefined;
  if (rest.length === 0) from = undefined;
  else if (rest.length === 2 && rest[0] === '--from' && rest[1] !== undefined && (NAMES as readonly string[]).includes(rest[1])) from = rest[1];
  else {
    console.log('usage: node scripts/android/checks/run.ts 8a [--from A0]');
    return 2;
  }

  const startedAt = Date.now();
  const id = stamp(new Date());
  const dir = join('.local', 'android', `8a-${id}`);
  const logPath = join('.local', 'android', `8a-${id}.log`);
  mkdirSync(dir, { recursive: true });
  const say = (line: string) => {
    console.log(line);
    appendFileSync(logPath, `${line}\n`);
  };

  let failed = false;
  const phone = emu();
  let made: Seed | undefined;
  let cues = { shown: 0, private: 2 };
  let seededAtSec = 0;
  const ctx: RunCtx = {
    dir,
    get seed() {
      if (made === undefined) throw new Error('no seed');
      return made;
    },
    set seed(value: Seed) { made = value; },
    get cues() { return cues; },
    set cues(value: { shown: number; private: number }) { cues = value; },
    get seededAtSec() { return seededAtSec; },
    set seededAtSec(value: number) { seededAtSec = value; },
    note: say,
    save(name, data) { writeFileSync(join(dir, name), data); },
    install: installApp,
    async reseed(p) {
      const sec = await cueClock(p, say);
      const next = { shown: awayFromQuiet(minuteOf(sec) + 6), private: awayFromQuiet(minuteOf(sec) + 8) };
      made = await seed(sec * 1000, next);
      cues = next;
      seededAtSec = sec;
      remember(next, sec);
      say(`A16 reseeded at minute ${minuteOf(sec)}, cues ${next.shown} and ${next.private}`);
    },
  };

  try {
    if (from !== 'A19') {
      say(`free memory before the emulator: ${(freemem() / GB).toFixed(1)} GB`);
      const booted = await startEmulator();
      if (!booted) {
        say('FAIL boot (the emulator did not start)');
        failed = true;
      } else {
        adbOnTestPhone(['root'], 60_000);
        adbOnTestPhone(['wait-for-device'], 120_000);
        const sec = deviceSec(phone);
        const saved = from === 'A17' || from === 'A18' ? readCues() : undefined;
        cues = saved ?? farCues(sec);
        seededAtSec = saved?.seededAtSec ?? sec;
        made = await seed(sec * 1000, cues);
        if (saved === undefined) remember(cues, seededAtSec);
        say(`seeded at phone minute ${minuteOf(sec)}, cues ${cues.shown} and ${cues.private}`);
        let reached = from === undefined;
        for (const check of checksA(ctx)) {
          if (!reached) {
            if (check.name === from) reached = true;
            else continue;
          }
          const t0 = Date.now();
          try {
            await check.run(phone);
            say(`PASS ${check.name} (${((Date.now() - t0) / 1000).toFixed(0)} s)`);
          } catch (err) {
            const message = err instanceof Error ? err.message : 'failed';
            if (err instanceof Platform) say(`PASS ${check.name} (platform: ${message})`);
            else {
              say(`FAIL ${check.name} (${message})`);
              failed = true;
              break;
            }
          }
        }
      }
    }
  } catch (err) {
    say(`FAIL setup (${err instanceof Error ? err.message : 'failed'})`);
    failed = true;
  } finally {
    if (from !== 'A19') {
      resetPhone();
      const stopped = await stopEmulator();
      say(stopped ? 'emulator stopped' : 'FAIL emulator stop');
      if (!stopped) failed = true;
    }
  }

  if (!failed && (from === undefined || from === 'A19')) {
    if (!avdListed('dc-api37')) say('SKIP A19 (dc-api37 does not exist)');
    else {
      const ran = spawnSync('npm', ['run', 'android:smoke', '--', '--avd', 'dc-api37'], {
        shell: true, encoding: 'utf8', windowsHide: true, timeout: 30 * 60_000, cwd: process.cwd(),
      });
      const out = `${ran.stdout ?? ''}${ran.stderr ?? ''}`;
      for (const line of out.split(/\r?\n/)) if (line.trim() !== '') say(line);
      const ok = ran.status === 0 && out.includes('smoke: every check PASS');
      say(ok ? 'PASS A19' : 'FAIL A19');
      if (!ok) failed = true;
    }
  }

  const wall = ((Date.now() - startedAt) / 60_000).toFixed(1);
  say(failed ? `emu-checks: FAIL (${wall} min)` : `emu-checks: every check PASS (${wall} min)`);
  return failed ? 1 : 0;
}

if (import.meta.main) process.exitCode = await main();
