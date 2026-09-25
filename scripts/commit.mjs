// The one way changes get committed to this repo.
//
//   node scripts/commit.mjs "Plain description of what changed"
//
// 1. runs the app's checks (type-check + tests) — a broken state is never committed
// 2. stages everything the ignore rules allow
// 3. runs the privacy guard on the staged files and on the message
// 4. commits (the git hooks run the same guard again)
//
// It never pushes. Pushing is done by hand, after reviewing what was committed.
import { execFileSync, spawnSync } from 'node:child_process';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const message = process.argv.slice(2).join(' ').trim();
if (!message) { console.error('usage: node scripts/commit.mjs "what changed"'); process.exit(2); }

const run = (cmd, args, opts = {}) => {
  const r = spawnSync(cmd, args, { stdio: 'inherit', shell: process.platform === 'win32' && cmd === 'npm', ...opts });
  if (r.status !== 0) { console.error(`\ncommit: stopped — ${cmd} ${args.join(' ')} failed.`); process.exit(r.status ?? 1); }
};
const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();

const root = git('rev-parse', '--show-toplevel');
process.chdir(root);

run('npm', ['run', 'check']);
run('git', ['add', '-A']);

const staged = git('diff', '--cached', '--name-only');
if (!staged) { console.log('commit: nothing to commit.'); process.exit(0); }

// check the message before committing, with the same guard the commit-msg hook uses
const msgFile = join(mkdtempSync(join(tmpdir(), 'commit-')), 'MSG');
writeFileSync(msgFile, message + '\n');
run('node', ['scripts/guard.mjs', 'message', msgFile]);
run('node', ['scripts/guard.mjs', 'staged']);

run('git', ['commit', '--file', msgFile]);
console.log('\ncommit: done. Nothing was pushed. Review it with:');
console.log('  git show --stat HEAD');
