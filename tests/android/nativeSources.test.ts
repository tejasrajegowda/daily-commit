import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const JAVA = join(import.meta.dirname, '..', '..', 'android', 'app', 'src', 'main', 'java', 'app', 'dailycommit');
const read = (f: string) => readFileSync(join(JAVA, f), 'utf8');
export const PLAIN = ['vault/VaultCore.java', 'vault/KeyStoreLike.java', 'vault/CopyFile.java', 'vault/Hkdf.java', 'vault/Codec.java'];
export const VAULT = PLAIN.filter(f => f.startsWith('vault/'));

test('the native cores are plain Java, so the JVM tests run them as they are', () => {
  for (const f of PLAIN) assert.doesNotMatch(read(f), /^import\s+(android|androidx|com\.getcapacitor)\./m, f);
});

test('nothing in vault/ writes anything out: no log, no print, no stack trace', () => {
  for (const f of VAULT) assert.doesNotMatch(read(f), /\bLog\.|System\.(out|err)|printStackTrace/, f);
});
