// Task 9's P3–P8 on the one real phone, by script. The owner does the fingerprint, the phone's own
// PIN, Android's file picker, the typing in another app, the diary words and the side key, and the yes/no only the owner's eyes can give; each is one `OWNER:` line, then a
// wait of at most 5 minutes, then "not done". Only the plan's Recorded items are printed and logged to
// .local/android/phone-<stamp>.log: numbers, yes/no, the keyboard's name. Never the phone's serial.
// npm run phone:checks
// npm run phone:checks -- --dry-run [--owner-wait 20]   (the dc- test emulator, started and stopped here)
// `--from P<n>` is refused before the phone is touched: a resumed run would skip the opening check.
// In the dry run a stand-in (standin.ts) does the owner's part at the file picker and answers the owner's questions
// from what the emulator measures; a fingerprint, the phone's PIN and the screen-off typing have no stand-in.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runAdb } from '../adbGate.ts';
import { adbOnTestPhone, driver, pause } from '../drive.ts';
import { startEmulator, stopEmulator } from '../emulator.ts';
import { runSync } from '../proc.ts';
import { isDcTestPhone } from '../smoke.ts';
import { DRY_RUN_SERIAL, guardedPhone, NOT_IN_APP, NotInApp, phoneTarget, Refused, type Adb } from './guard.ts';
import { LONG_FILE } from './long.ts';
import { answerOf, ITEMS, NOT_TEST_RECORD, phoneMayRun, RUN, STEPS, type ItemKey, type Owner, type PCtx, type StandIn, type Step } from './p.ts';
import { dryRunStandIn } from './standin.ts';

export const OWNER_WAIT_MS = 5 * 60_000;

export interface SittingArgs { readonly from: Step; readonly dryRun: boolean; readonly ownerWaitMs: number }

/** `--from P<n>`, `--dry-run`, and `--owner-wait <seconds>` (the dry run only). Anything else is refused. */
export function parseArgs(argv: readonly string[]): SittingArgs | undefined {
  let from: Step = 'P3';
  let dryRun = false;
  let ownerWaitMs = OWNER_WAIT_MS;
  let waitGiven = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const v = argv[i + 1];
    if (a === '--from' && v !== undefined && (STEPS as readonly string[]).includes(v)) {
      from = v as Step;
      i++;
    } else if (a === '--dry-run') {
      dryRun = true;
    } else if (a === '--owner-wait' && v !== undefined && /^\d{1,3}$/.test(v) && Number(v) >= 5) {
      ownerWaitMs = Number(v) * 1000;
      waitGiven = true;
      i++;
    } else {
      return undefined;
    }
  }
  if (waitGiven && !dryRun) return undefined;          // on the phone the owner always gets 5 minutes
  return { from, dryRun, ownerWaitMs };
}

/** `--from P<n>` resumes past the opening check, so the run is refused before the phone is touched. */
export function fromRun(argv: readonly string[]): boolean {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--from' && (STEPS as readonly string[]).includes(argv[i + 1] ?? '')) return true;
  }
  return false;
}

function stamp(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function realAdb(): Adb {
  return (args, timeoutMs = 60_000) => {
    const ran = runAdb('phoneChecks', args, { timeoutMs, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
    return { code: ran.status ?? 1, out: ran.out };
  };
}

/** The owner's steps. With a stand-in (the dry run only), it acts or answers first and says so in one line. */
export function owner(say: (line: string) => void, answers: string, waitMs: number, standIn?: StandIn): Owner {
  const tried = <T>(run: () => T): T | undefined => {
    try {
      return run();
    } catch (err) {
      say(`  the stand-in could not: ${err instanceof Error ? err.message : 'failed'}`);
      return undefined;
    }
  };
  return {
    wait(what, done, act) {
      say(`OWNER: ${what}`);
      if (standIn !== undefined && act !== undefined) {
        say('  the dry run\'s stand-in does it on the emulator');
        tried(() => standIn.act(act));
      }
      const until = Date.now() + waitMs;
      for (;;) {
        if (done()) return true;
        if (Date.now() >= until) {
          say('  not done in time');
          return false;
        }
        pause(1500);
      }
    },
    ask(key, question) {
      say(`OWNER: ${question} (answer: a line "${key}=yes" or "${key}=no" in ${answers.split('\\').join('/')})`);
      const stood = standIn === undefined ? undefined : tried(() => standIn.answer(key));
      if (stood !== undefined) {
        say(`  the dry run's stand-in measured it on the emulator: ${stood.value}`);
        return `${stood.value} (emulator stand-in: ${stood.how})`;
      }
      const until = Date.now() + waitMs;
      for (;;) {
        const got = answerOf(existsSync(answers) ? readFileSync(answers, 'utf8') : '', key);
        if (got !== undefined) return got;
        if (Date.now() >= until) {
          say('  not done in time');
          return 'not done';
        }
        pause(2000);
      }
    },
  };
}

/** The dry run's test phone: booted behind the memory gate, named dc-, the release APK installed, its data cleared. */
async function prepareDryRun(say: (line: string) => void): Promise<boolean> {
  if (!(await startEmulator())) {
    say('FAIL the dc- test emulator did not start');
    return false;
  }
  const named = adbOnTestPhone(['emu', 'avd', 'name'], 30_000);
  if (named.code !== 0 || !isDcTestPhone(named.out)) {
    say('FAIL emulator-5556 is not a dc- test phone');
    return false;
  }
  const ran = runSync('npm', ['run', 'phone', '--', '--serial', DRY_RUN_SERIAL], {
    shell: true, encoding: 'utf8', windowsHide: true, timeout: 300_000, cwd: process.cwd(),
  });
  if (!/Installed .+ over what was there/.test(`${ran.stdout ?? ''}${ran.stderr ?? ''}`)) {
    say('FAIL the release APK did not install on the test emulator');
    return false;
  }
  // The test phone only, after its name was checked: the phone itself is never cleared.
  adbOnTestPhone(['shell', 'pm clear app.dailycommit'], 60_000);
  say('dry run: the release APK is on the dc- test emulator, its data cleared');
  return true;
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const args = parseArgs(argv);
  if (args === undefined) {
    console.log('usage: npm run phone:checks [-- --dry-run [--owner-wait <seconds>]]');
    return 2;
  }
  if (fromRun(argv)) {
    console.log(NOT_TEST_RECORD);
    return 1;
  }
  const id = stamp(new Date());
  mkdirSync(join('.local', 'android'), { recursive: true });
  const logPath = join('.local', 'android', `phone-${id}.log`);
  const answers = join('.local', 'android', `phone-${id}-answers.txt`);
  writeFileSync(answers, '# The owner\'s answers, one per line, for example: P6.screenshot=yes\n');
  const say = (line: string) => {
    console.log(line);
    appendFileSync(logPath, `${line}\n`);
  };
  const startedAt = Date.now();
  say(args.dryRun ? `phone-checks: dry run on the dc- test emulator, from ${args.from}` : `phone-checks: the phone, from ${args.from}`);

  const adb = realAdb();
  let serial: string;
  if (args.dryRun) {
    serial = DRY_RUN_SERIAL;
  } else {
    const target = phoneTarget(adb(['devices'], 30_000).out);
    if (!target.ok) {
      say(target.why);
      return 1;
    }
    serial = target.serial;
  }

  const results = new Map<ItemKey, string>();
  let failed = false;
  try {
    if (args.dryRun && !(await prepareDryRun(say))) return 1;
    const io = guardedPhone(serial, adb, { dryRun: args.dryRun });
    if (!io.shell('pm path app.dailycommit').out.includes('package:')) {
      say('Daily Commit is not installed on the phone. Install it with npm run phone first. Nothing was run.');
      return 1;
    }
    const ctx: PCtx = {
      phone: driver(io),
      front: () => io.front(),
      pushLong: () => existsSync(LONG_FILE) && io.pushLong(LONG_FILE),
      owner: owner(say, answers, args.ownerWaitMs, args.dryRun ? dryRunStandIn() : undefined),
      recorded: key => results.has(key),
      record(key, value) {
        results.set(key, value);
        const label = ITEMS.find(i => i.key === key)?.label ?? key;
        say(`${key.slice(0, 2)} ${label}: ${value}`);
      },
      note: say,
      timingOn: false,
      proved: false,
    };
    // Before any step. A step may make a record or replace one, and this is the only place that may allow that.
    if (!phoneMayRun(ctx)) {
      say(NOT_TEST_RECORD);
      return 1;
    }
    for (const step of STEPS.slice(STEPS.indexOf(args.from))) {
      const t0 = Date.now();
      say(`${step} start`);
      try {
        RUN[step](ctx);
        say(`${step} end (${((Date.now() - t0) / 1000).toFixed(0)} s)`);
      } catch (err) {
        if (err instanceof NotInApp) say(`${step} ${NOT_IN_APP}`);
        else {
          say(`${step} stopped: ${err instanceof Error ? err.message : 'failed'}`);
          if (err instanceof Refused) {
            failed = true;
            break;
          }
        }
      }
    }
    try {
      io.shell('setprop log.tag.DailyCommit ""');
    } catch {
      // The phone may be gone; the switch also clears with a restart of the phone.
    }
  } finally {
    if (args.dryRun) {
      const stopped = await stopEmulator();
      say(stopped ? 'emulator stopped' : 'FAIL emulator stop');
      if (!stopped) failed = true;
    }
  }

  say('results:');
  for (const item of ITEMS) say(`  ${item.key} ${item.label}: ${results.get(item.key) ?? 'not done'}`);
  say(`phone-checks: ${failed ? 'FAIL' : 'done'} (${((Date.now() - startedAt) / 60_000).toFixed(1)} min); log ${logPath.split('\\').join('/')}`);
  return failed ? 1 : 0;
}

if (import.meta.main) process.exitCode = await main();
