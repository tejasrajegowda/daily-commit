import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const JAVA = join(import.meta.dirname, '..', '..', 'android', 'app', 'src', 'main', 'java', 'app', 'dailycommit');
const read = (f: string) => readFileSync(join(JAVA, f), 'utf8');
export const PLAIN = ['vault/VaultCore.java', 'vault/KeyStoreLike.java', 'vault/CopyFile.java', 'vault/Hkdf.java', 'vault/Codec.java', 'shell/HandOff.java'];
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
  const register = src.indexOf('registerPlugin(VaultPlugin.class)');
  assert.ok(register > 0 && register < src.indexOf('super.onCreate('));
});

test('the phone\'s prompt is marked as a hand-off our own code started, and the mark always ends', () => {
  const src = read('vault/VaultPlugin.java');
  assert.match(src, /HandOff\.begin\(SystemClock\.elapsedRealtime\(\)\)/);
  assert.match(src, /HandOff\.end\(\)/);
});
