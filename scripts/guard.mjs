// Privacy and identity checks for commits and pushes.
//
//   node scripts/guard.mjs staged              check the staged files (pre-commit)
//   node scripts/guard.mjs message <file>      check a commit message (commit-msg)
//   node scripts/guard.mjs outgoing            check commits about to be pushed (pre-push; refs on stdin)
//
// Every rule is read from .local/guard.json, which is never committed: the words that must not
// appear, the paths that must not be committed, and the expected author identity. If that file is
// missing, every check fails — the guard fails closed, never open.
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const git = (...args) => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).trim();
const root = git('rev-parse', '--show-toplevel');
const configPath = join(root, '.local', 'guard.json');

function fail(lines) {
  console.error('\nguard: refused.\n' + lines.map(l => '  - ' + l).join('\n') + '\n');
  process.exit(1);
}
if (!existsSync(configPath)) fail(['.local/guard.json is missing, so nothing can be checked — refusing (fail closed).']);
const cfg = JSON.parse(readFileSync(configPath, 'utf8'));
const words = (cfg.forbiddenWords ?? []).map(w => String(w).toLowerCase()).filter(Boolean);
const paths = (cfg.forbiddenPaths ?? []).map(String).filter(Boolean);
// absolute paths reveal the machine's user and folders; always forbidden in committed text
const ABSOLUTE = /\b[a-z]:[\\/]+users[\\/]/i;

// Short entries (4 characters or fewer) match only as whole words, so a random run of letters
// inside a hash can never trip them; longer entries match anywhere, including inside other words.
const escape = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const matchers = words.map(w => w.length <= 4 ? new RegExp(`(?<![a-z0-9])${escape(w)}(?![a-z0-9])`) : { test: t => t.includes(w) });

function scanText(label, text) {
  const problems = [];
  const lower = text.toLowerCase();
  matchers.forEach((m, i) => { if (m.test(lower)) problems.push(`${label} contains a forbidden word (entry ${i + 1} in guard.json)`); });
  if (ABSOLUTE.test(text)) problems.push(`${label} contains an absolute path to a user folder`);
  return problems;
}
function checkIdentity() {
  const email = git('config', 'user.email');
  const name = git('config', 'user.name');
  const problems = [];
  if (cfg.expectedEmail && email !== cfg.expectedEmail) problems.push('the commit author email is not the expected personal identity');
  if (cfg.expectedName && name !== cfg.expectedName) problems.push('the commit author name is not the expected personal identity');
  return problems;
}

const mode = process.argv[2];

if (mode === 'staged') {
  const problems = [...checkIdentity()];
  const files = git('diff', '--cached', '--name-only', '--diff-filter=ACMR').split('\n').filter(Boolean);
  for (const f of files) {
    for (const p of paths) if (f === p || f.startsWith(p) || f.toLowerCase().endsWith(p.toLowerCase())) problems.push(`${f} is a local-only file`);
    let blob = '';
    try { blob = git('show', `:${f}`); } catch { continue; }       // binary or unreadable: path checks only
    if (blob.includes('\u0000')) continue;                           // binary file
    problems.push(...scanText(f, blob));
    problems.push(...scanText(`the file name ${f}`, f));
  }
  if (problems.length) fail(problems);
  console.log(`guard: ${files.length} staged file(s) checked — clean.`);
} else if (mode === 'message') {
  const text = readFileSync(process.argv[3], 'utf8').split('\n').filter(l => !l.startsWith('#')).join('\n');
  const problems = scanText('the commit message', text);
  if (/^\s*[a-z-]+-by:/im.test(text)) problems.push('the commit message has a trailer line (for example a co-author line)');
  if (problems.length) fail(problems);
} else if (mode === 'outgoing') {
  const problems = [];
  const input = readFileSync(0, 'utf8').trim();
  for (const line of input.split('\n').filter(Boolean)) {
    const [, localSha, , remoteSha] = line.split(' ');
    if (!localSha || /^0+$/.test(localSha)) continue;               // deleting a ref: nothing to scan
    const range = !remoteSha || /^0+$/.test(remoteSha) ? localSha : `${remoteSha}..${localSha}`;
    for (const sha of git('rev-list', range).split('\n').filter(Boolean)) {
      const msg = git('log', '-1', '--format=%B', sha);
      const author = git('log', '-1', '--format=%ae', sha);
      problems.push(...scanText(`commit ${sha.slice(0, 7)} message`, msg));
      if (/^\s*[a-z-]+-by:/im.test(msg)) problems.push(`commit ${sha.slice(0, 7)} has a trailer line`);
      if (cfg.expectedEmail && author !== cfg.expectedEmail) problems.push(`commit ${sha.slice(0, 7)} has an unexpected author email`);
    }
    for (const f of git('ls-tree', '-r', '--name-only', localSha).split('\n').filter(Boolean))
      for (const p of paths) if (f === p || f.startsWith(p) || f.toLowerCase().endsWith(p.toLowerCase())) problems.push(`${f} is a local-only file`);
  }
  if (problems.length) fail(problems);
  console.log('guard: outgoing commits checked — clean.');
} else {
  fail([`unknown mode "${mode}" — use staged, message <file>, or outgoing`]);
}
