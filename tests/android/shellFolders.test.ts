import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { PREUPGRADE, REPLACED, SAFETY } from '../../src/record/backup/copies.ts';
import { LOG_DIR } from '../../src/record/backup/monthLog.ts';
import { LATEST, OLDER } from '../../src/record/backup/snapshot.ts';

// The record's files go through the phone's ShellFiles, which refuses any folder not on its own list. The tests
// run the record on an in-memory stand-in that takes any name, so a folder the record starts using and the phone
// doesn't know only shows on a device: as a start that fails. That happened with log-replaced/ (the tablet run,
// 16 Nov). This keeps the two lists the same.

const JAVA = 'android/app/src/main/java/app/dailycommit/shell/ShellFiles.java';
const top = (path: string) => path.split('/')[0] ?? '';

function phoneFolders(): string[] {
  const src = readFileSync(JAVA, 'utf8');
  const m = /FOLDERS = Set\.of\(([^)]*)\)/.exec(src);
  assert.ok(m?.[1], 'ShellFiles.FOLDERS is a Set.of(...)');
  return [...m[1].matchAll(/"([^"]+)"/g)].map(x => x[1] ?? '').sort();
}

/** Every top folder a path literal in src/record names: 'x/…' or `x/…`. */
function recordFolders(): string[] {
  const found = new Set<string>();
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (/\.tsx?$/.test(name) && !name.includes('.test.')) {
        for (const lit of readFileSync(path, 'utf8').matchAll(/['`]([a-z]+(?:-[a-z]+)*)\/[^'`$\s]*['`$]/g)) found.add(lit[1] ?? '');
      }
    }
  };
  walk('src/record');
  return [...found].sort();
}

test('the phone\'s file folders are exactly the record\'s', () => {
  const used = new Set([top(LATEST), top(OLDER), top(LOG_DIR), SAFETY, PREUPGRADE, REPLACED, 'tmp']);
  assert.deepEqual(phoneFolders(), [...used].sort());
});

test('every folder a record path names is one the phone allows', () => {
  const allowed = new Set(phoneFolders());
  for (const folder of recordFolders()) assert.ok(allowed.has(folder), `src/record names ${folder}/, which ShellFiles refuses`);
});

test('the phone\'s path pattern takes every one of its folders', () => {
  const src = readFileSync(JAVA, 'utf8');
  const pattern = /Pattern\.compile\("([^"]+)"\)/.exec(src)?.[1];
  assert.ok(pattern);
  const re = new RegExp(`^(?:${pattern.replace(/\\\\/g, '\\')})$`);
  for (const folder of phoneFolders()) assert.ok(re.test(`${folder}/x.dcbak`), `${folder}/x.dcbak`);
});
