import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EMULATOR_SERIAL } from '../../scripts/android/adbGate.ts';
import { DRY_RUN_SERIAL } from '../../scripts/android/checks/guard.ts';
import { NOT_TEST_RECORD, phoneMayRun, type PCtx } from '../../scripts/android/checks/p.ts';
import { LONG_PASSPHRASE } from '../../scripts/android/checks/long.ts';
import { owner } from '../../scripts/android/checks/sitting.ts';
import { driver, inputTextArg, TEST_SERIAL, type DeviceIo, type UiNode } from '../../scripts/android/drive.ts';
import { SERIAL } from '../../scripts/android/emulator.ts';

const ROOT = fileURLToPath(new URL('../../scripts/android/', import.meta.url));

function scripts(): string[] {
  const out: string[] = [];
  const walk = (dir: string, rel: string): void => {
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      const childRel = rel === '' ? ent.name : `${rel}/${ent.name}`;
      const child = join(dir, ent.name);
      if (ent.isDirectory()) walk(child, childRel);
      else if (ent.name.endsWith('.ts')) out.push(`scripts/android/${childRel.split('\\').join('/')}`);
    }
  };
  walk(ROOT, '');
  return out.sort();
}

function readScript(rel: string): string {
  return readFileSync(new URL(`../../${rel}`, import.meta.url), 'utf8');
}

/** Comments removed, so a commented line can't stand in for code. */
function withoutComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '$1');
}

/** proc.ts names adb only to refuse it: every spawn there must be preceded by its own refusal. */
function procBalanced(src: string): boolean {
  const code = withoutComments(src);
  const spawns = (code.match(/\b(?:spawnSync|spawn)\s*\(/g) ?? []).length;
  const refusals = (code.match(/throw new Error\(NOT_THROUGH_GATE\)/g) ?? []).length;
  return spawns === refusals;
}

function firstArg(src: string, from: number): string | undefined {
  const q = src[from];
  if (q !== '\'' && q !== '"' && q !== '`') return undefined;
  let i = from + 1;
  let body = '';
  while (i < src.length) {
    const ch = src[i] ?? '';
    if (ch === '\\') { body += src[i + 1] ?? ''; i += 2; continue; }
    if (q === '`' && ch === '$' && src[i + 1] === '{') {
      body += '${';
      i += 2;
      let depth = 1;
      while (i < src.length && depth > 0) {
        const d = src[i] ?? '';
        if (d === '{') depth++;
        else if (d === '}') depth--;
        if (depth > 0) body += d;
        i++;
      }
      continue;
    }
    if (ch === q) return body;
    body += ch;
    i++;
  }
  return body;
}

/** Why this file starts adb, or undefined when it does not. adbGate.ts is the one place that may. */
function startsAdb(rel: string, src: string): string | undefined {
  if (rel === 'scripts/android/adbGate.ts') return undefined;
  if (src.includes('paths.adb')) return 'paths.adb';
  if (/toolPaths\s*\([^)]*\)\s*\.adb/.test(src)) return 'toolPaths().adb';
  if (src.includes('.adb,')) return '.adb,';
  const re = /\b(execFileSync|execFile|execSync|spawnSync|spawn|runSyncCommand|runSync|startChild|exec)\s*\(\s*(['"`])/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    const callee = m[1] ?? '';
    const body = firstArg(src, m.index + m[0].length - 1);
    if (body === undefined || !body.includes('adb')) continue;
    if (rel === 'scripts/android/phone.ts' && callee === 'exec' && body === 'adb') continue;
    return `${callee} starts adb`;
  }
  // adbGate.test.ts proves the refusal at run time; the next test keeps child_process out of every other file.
  if (rel === 'scripts/android/proc.ts' && !procBalanced(src)) return 'a spawn in proc.ts without its adb refusal';
  return undefined;
}

function laneOf(rel: string): 'install' | 'phoneChecks' | 'emulator' | undefined {
  if (rel === 'scripts/android/adbGate.ts') return undefined;
  if (rel === 'scripts/android/phone.ts') return 'install';
  if (rel === 'scripts/android/checks/sitting.ts' || rel === 'scripts/android/checks/guard.ts') return 'phoneChecks';
  return 'emulator';
}

test('RF1: only adbGate.ts starts adb, and each file calls runAdb on its own lane', () => {
  const problems: string[] = [];
  for (const rel of scripts()) {
    const src = readScript(rel);
    const started = startsAdb(rel, src);
    if (started !== undefined) problems.push(`${rel}: ${started}`);
    const lane = laneOf(rel);
    if (lane === undefined) continue;
    const re = /runAdb\s*\(/g;
    let seen = false;
    let m: RegExpExecArray | null;
    while ((m = re.exec(src)) !== null) {
      seen = true;
      const lit = /^\s*(['"])(install|phoneChecks|emulator)\1/.exec(src.slice(m.index + m[0].length));
      if (lit === null) problems.push(`${rel}: runAdb lane is not a string literal`);
      else if (lit[2] !== lane) problems.push(`${rel}: runAdb('${lit[2]}') is not the ${lane} lane`);
    }
    if ((lane === 'install' || lane === 'phoneChecks') && !seen) problems.push(`${rel}: does not call runAdb`);
  }
  assert.deepEqual(problems, []);
});

test('RF1: only adbGate.ts and proc.ts may start a process at all', () => {
  // Raw text, any spelling: an import with or without node:, a require, a dynamic import, or
  // process.binding. Every other script starts a process through proc.ts, which refuses adb.
  const problems: string[] = [];
  for (const rel of scripts()) {
    if (rel === 'scripts/android/adbGate.ts' || rel === 'scripts/android/proc.ts') continue;
    const src = readScript(rel);
    if (/child_process/.test(src)) problems.push(`${rel}: names child_process`);
    if (/process\s*\.\s*binding|internalBinding/.test(src)) problems.push(`${rel}: reaches node internals`);
  }
  assert.deepEqual(problems, []);
});

test('RF1: a commented refusal does not balance a spawn in proc.ts', () => {
  const refused = 'if (refusesAdbCall(f, a)) throw new Error(NOT_THROUGH_GATE);\n  return spawnSync(f, a, o);\n';
  assert.equal(procBalanced(refused), true);
  assert.equal(procBalanced(`${refused}  // throw new Error(NOT_THROUGH_GATE)\n  spawnSync(f, a, o);\n`), false);
  assert.equal(procBalanced(`${refused}  /* throw new Error(NOT_THROUGH_GATE) */\n  spawnSync(f, a, o);\n`), false);
  assert.equal(procBalanced(readScript('scripts/android/proc.ts')), true);
});

test('RF1: the dry run and the emulator install name emulator-5556', () => {
  assert.equal(EMULATOR_SERIAL, 'emulator-5556');
  assert.equal(SERIAL, EMULATOR_SERIAL);
  assert.equal(TEST_SERIAL, EMULATOR_SERIAL);
  assert.equal(DRY_RUN_SERIAL, EMULATOR_SERIAL);
  const run = readScript('scripts/android/checks/run.ts');
  assert.match(run, /\[\s*'run'\s*,\s*'phone'\s*,\s*'--'\s*,\s*'--serial'\s*,\s*'emulator-5556'\s*\]/);
  const sitting = readScript('scripts/android/checks/sitting.ts');
  assert.match(sitting, /\[\s*'run'\s*,\s*'phone'\s*,\s*'--'\s*,\s*'--serial'\s*,\s*DRY_RUN_SERIAL\s*\]/);
});

// sitting.test.ts does not export its phone fake. This is that file's passphrase-failure case, rebuilt here.
const USE_B: UiNode['bounds'] = [100, 400, 800, 480];
const PASS_B: UiNode['bounds'] = [100, 700, 800, 780];
const OPEN_B: UiNode['bounds'] = [400, 900, 700, 980];
const START_B: UiNode['bounds'] = [100, 1500, 800, 1580];
const REPLACE_B: UiNode['bounds'] = [100, 1700, 800, 1780];

function box(text: string, bounds: UiNode['bounds'], cls = 'android.widget.Button'): UiNode {
  return { text, desc: '', id: '', cls, bounds, enabled: true, pkg: 'app.dailycommit' };
}

function mid(bounds: UiNode['bounds']): string {
  return `${Math.floor((bounds[0] + bounds[2]) / 2)},${Math.floor((bounds[1] + bounds[3]) / 2)}`;
}

function gatePhone(screen: (phase: string) => readonly UiNode[]): { taps: string[]; commands: string[]; notes: string[]; ctx: PCtx } {
  let phase = 'start';
  const taps: string[] = [];
  const commands: string[] = [];
  const notes: string[] = [];
  const io: DeviceIo = {
    shell(c) {
      commands.push(c);
      if (c.includes('KEYCODE_HOME') || c.includes('am start')) phase = 'lock';
      if (c.startsWith('input text ')) phase = 'after';
      const tap = /^input tap (\d+) (\d+)$/.exec(c);
      if (tap?.[1] !== undefined && tap[2] !== undefined) taps.push(`${tap[1]},${tap[2]}`);
      return { code: 0, out: c === 'wm size' ? 'Physical size: 1080x2400' : '' };
    },
    execOut() { throw new Error('no'); },
    finger() { throw new Error('no'); },
    dump: () => ({ xml: '', nodes: [...screen(phase)] }),
  };
  const ctx: PCtx = {
    phone: driver(io),
    front: () => 'app',
    pushLong: () => false,
    owner: owner(() => undefined, 'answers-that-do-not-exist.txt', 0),
    record() {},
    recorded: () => false,
    note: line => notes.push(line),
    timingOn: false,
    proved: false,
  };
  return { taps, commands, notes, ctx };
}

function lockScreen(failed: boolean): UiNode[] {
  const nodes = [
    box('Locked', [40, 200, 400, 280], 'android.widget.TextView'),
    box('Use your passphrase', USE_B),
    box('Passphrase', PASS_B, 'android.widget.TextView'),
    box('', [80, 800, 900, 880], 'android.widget.EditText'),
    box('Open', OPEN_B),
    box('Start new instead', START_B),
    box('Replace everything', REPLACE_B),
  ];
  if (failed) {
    nodes.push(box("That didn't open it. Check it and try again.", [40, 1100, 900, 1200], 'android.widget.TextView'));
    nodes.push(box('CANARY habit 0', [40, 1240, 900, 1320], 'android.widget.TextView'));
    nodes.push(box('ZEDHABIT', [40, 1340, 900, 1420], 'android.widget.TextView'));
  }
  return nodes;
}

test('RF1: the phone checks refuse a record that is not the test one', () => {
  const open = gatePhone(phase => (phase === 'after' ? lockScreen(true) : phase === 'lock' ? lockScreen(false) : [
    box('Today', [0, 2200, 270, 2400]),
    box('Diary', [540, 2200, 810, 2400]),
    box('CANARY habit 0', [40, 500, 900, 600], 'android.widget.TextView'),
    box('ZEDHABIT', [40, 640, 900, 740], 'android.widget.TextView'),
  ]));
  assert.equal(LONG_PASSPHRASE, 'CANARY phone test passphrase');
  assert.equal(NOT_TEST_RECORD, 'refused: this phone holds a record that is not the test one');
  assert.equal(phoneMayRun(open.ctx), false);
  assert.equal(open.ctx.proved, false);
  const textAt = open.commands.findIndex(c => c.startsWith('input text '));
  assert.ok(textAt > 0);
  assert.equal(open.commands[textAt], `input text ${inputTextArg(LONG_PASSPHRASE)}`);
  assert.equal(open.commands.slice(textAt + 1).some(c => c.startsWith('input tap ')), false);
  assert.equal(open.taps.includes(mid(START_B)), false);
  assert.equal(open.taps.includes(mid(REPLACE_B)), false);
  assert.deepEqual(open.notes, []);
  assert.doesNotMatch(open.commands.join('\n'), /ZEDHABIT|CANARY habit/);
});
