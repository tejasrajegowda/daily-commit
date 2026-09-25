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

const stopIfFailed = (r, what) => {
  if (r.status !== 0) { console.error(`\ncommit: stopped — ${what} failed.`); process.exit(r.status ?? 1); }
};
const run = (cmd, args) => stopIfFailed(spawnSync(cmd, args, { stdio: 'inherit' }), `${cmd} ${args.join(' ')}`);
// npm is a shell script on Windows, so it goes through the shell as one fixed string
const npm = (script) => stopIfFailed(spawnSync(`npm run ${script}`, { stdio: 'inherit', shell: true }), `npm run ${script}`);
const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();

const root = git('rev-parse', '--show-toplevel');
process.chdir(root);

npm('check');
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
