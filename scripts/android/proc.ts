// Every child process of the Android scripts that is not adb. adbGate.ts is the only other file
// that may start a process, and the only way to adb. Here adb is refused at run time wherever it
// appears: as the program, as any argument (a shell's "-Command adb pull …", or "cmd /c <adb path>"),
// or inside a command line. A test keeps child_process out of every other script.
import { spawn, spawnSync, type ChildProcess, type SpawnOptions, type SpawnSyncOptions, type SpawnSyncReturns } from 'node:child_process';

export const NOT_THROUGH_GATE = 'refused: adb starts only through adbGate';

/**
 * adb as a word: a bare name, or the end of a path, quoted, in a powershell block or not, with any
 * extension Windows runs. apksigner and apkanalyzer don't match.
 */
const ADB_WORD = /(^|[\s"'\\/=(&|;,`{])adb(\.(exe|cmd|bat|com))?(?=["'\s)&|;,`}]|$)/i;

/** True when adb appears as a word in this text. */
export function mentionsAdb(text: string): boolean {
  return ADB_WORD.test(text.trim());
}

export function refusesAdbFile(file: string): boolean {
  return mentionsAdb(file);
}

export function refusesAdbCommand(command: string): boolean {
  return mentionsAdb(command);
}

/** The program or any argument names adb. */
export function refusesAdbCall(file: string, args: readonly string[]): boolean {
  return mentionsAdb(file) || args.some(mentionsAdb);
}

export function runSync(file: string, args: readonly string[], opts: SpawnSyncOptions): SpawnSyncReturns<string | Buffer> {
  if (refusesAdbCall(file, args)) throw new Error(NOT_THROUGH_GATE);
  return spawnSync(file, [...args], opts);
}

/** A single command line, for a .bat or a shell command. */
export function runSyncCommand(command: string, opts: SpawnSyncOptions): SpawnSyncReturns<string | Buffer> {
  if (refusesAdbCommand(command)) throw new Error(NOT_THROUGH_GATE);
  return spawnSync(command, opts);
}

/** A process left running. The caller waits on it. */
export function startChild(file: string, args: readonly string[], opts: SpawnOptions): ChildProcess {
  if (refusesAdbCall(file, args)) throw new Error(NOT_THROUGH_GATE);
  return spawn(file, [...args], opts);
}
