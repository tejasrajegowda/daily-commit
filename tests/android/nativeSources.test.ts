import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const JAVA = join(import.meta.dirname, '..', '..', 'android', 'app', 'src', 'main', 'java', 'app', 'dailycommit');
const read = (f: string) => readFileSync(join(JAVA, f), 'utf8');
export const PLAIN = ['vault/VaultCore.java', 'vault/KeyStoreLike.java', 'vault/CopyFile.java', 'vault/Hkdf.java', 'vault/Codec.java', 'shell/HandOff.java', 'shell/LockWatch.java', 'shell/ShellFiles.java'];
export const VAULT = [...PLAIN.filter(f => f.startsWith('vault/')), 'vault/AndroidKeys.java', 'vault/VaultPlugin.java'];

test('the native cores are plain Java, so the JVM tests run them as they are', () => {
  for (const f of PLAIN) assert.doesNotMatch(read(f), /^import\s+(android|androidx|com\.getcapacitor)\./m, f);
});

test('nothing in vault/ writes anything out: no log, no print, no stack trace', () => {
  for (const f of VAULT) assert.doesNotMatch(read(f), /\bLog\.|System\.(out|err)|printStackTrace/, f);
});

test('the Vault plugin answers exactly the five calls of src/vault/plugin.ts', () => {
  const src = read('vault/VaultPlugin.java');
  const methods = [...src.matchAll(/@PluginMethod\s+public void (\w+)\(PluginCall/g)].map(m => m[1]).sort();
  assert.deepEqual(methods, ['enrol', 'remove', 'status', 'unwrap', 'verifyCode']);
  assert.match(src, /@CapacitorPlugin\(name = "Vault"\)/);
});

test('both plugins are registered before the bridge is built', () => {
  const src = read('MainActivity.java');
  const bridge = src.indexOf('super.onCreate(');
  for (const name of ['registerPlugin(VaultPlugin.class)', 'registerPlugin(ShellPlugin.class)']) {
    const register = src.indexOf(name);
    assert.ok(register > 0 && register < bridge, name);
  }
});

test('the phone\'s prompt is marked as a hand-off our own code started, and the mark always ends', () => {
  const src = read('vault/VaultPlugin.java');
  assert.match(src, /HandOff\.begin\(SystemClock\.elapsedRealtime\(\)\)/);
  assert.match(src, /HandOff\.end\(\)/);
});

test('the Shell plugin keeps nothing of a pending call in Android\'s saved state', () => {
  assert.match(read('shell/ShellPlugin.java'), /protected Bundle saveInstanceState\(\)\s*\{\s*return null;\s*\}/);
});

test('a result that arrives after Android ended the app is dropped', () => {
  const src = read('shell/ShellPlugin.java');
  assert.equal([...src.matchAll(/CALLBACK_ID_DANGLING/g)].length >= 2, true);     // both "save as" and the picker
});

test('the only log line in the app is the timing line, behind isLoggable, numbers only', () => {
  const src = read('shell/ShellPlugin.java');
  const uses = [...src.matchAll(/\bLog\.(\w+)\(/g)].map(m => m[1]);
  assert.deepEqual(uses.sort(), ['isLoggable', 'v']);
  assert.match(src, /Log\.v\(TAG, label \+ " " \+ ms \+ " ms"\)/);
});

test('every hand-off ends in one place, which locks when the activity has stopped', () => {
  const shell = read('shell/ShellPlugin.java');
  const vault = read('vault/VaultPlugin.java');
  assert.match(shell, /public void endHandOff\(\)/);
  assert.match(shell, /watch\.handOffEnded\(started\)/);
  assert.equal([...shell.matchAll(/HandOff\.end\(\)/g)].length, 1);
  const body = (src: string, signature: string) => {
    const at = src.indexOf(signature);
    assert.ok(at > 0, signature);
    const next = src.indexOf('\n    @', at + signature.length);
    return src.slice(at, next < 0 ? src.length : next);
  };
  for (const signature of ['private void saved(', 'private void picked(', 'private void notificationsAnswered(']) {
    assert.match(body(shell, signature), /endHandOff\(\)/, signature);
  }
  const finished = vault.slice(vault.indexOf('private void finished('), vault.indexOf('private void endHandOff('));
  assert.match(finished, /endHandOff\(\)/);
  assert.doesNotMatch(finished, /HandOff\.end\(\)/);
});

test('every system screen the Shell opens is marked as a hand-off first', () => {
  const src = read('shell/ShellPlugin.java');
  for (const opener of ['startActivityForResult(', 'requestPermissionForAlias(']) {
    for (const m of src.matchAll(new RegExp(opener.replace('(', '\\('), 'g'))) {
      const before = src.slice(Math.max(0, (m.index ?? 0) - 200), m.index);
      assert.match(before, /HandOff\.begin\(/, opener);
    }
  }
});
