// Checks the release build in dist/ after `vite build`: nothing from the screen harness may be in
// it, and its pages keep the content policy (no inline script or style, and a policy that keeps
// script and the network to the app itself). Run by `npm run build`.
// node scripts/release-check.ts → one line per problem, exit 1 if there is any.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join, relative, sep } from 'node:path';

/** Text that only the harness or the tests contain. */
const HARNESS_MARKS = ['seedRecord', 'fakePlugin', 'HARNESS_', 'CANARY'];
const TEXT = new Set(['.html', '.js', '.mjs', '.css', '.json', '.txt', '.svg', '.map']);

/** Every problem with a build, given as its files' paths (with "/") and text. */
export function releaseProblems(files: ReadonlyMap<string, string>): string[] {
  const problems: string[] = [];
  for (const [path, text] of files) {
    if (/harness/i.test(path)) problems.push(`${path}: a harness file`);
    for (const mark of HARNESS_MARKS) if (text.includes(mark)) problems.push(`${path}: contains ${mark}`);
    if (!path.endsWith('.html')) continue;
    for (const tag of text.matchAll(/<script\b([^>]*)>/gi)) if (!/\bsrc\s*=/.test(tag[1] ?? '')) problems.push(`${path}: an inline script`);
    if (/<style\b/i.test(text)) problems.push(`${path}: a style element`);
    if (/\sstyle\s*=/i.test(text)) problems.push(`${path}: a style attribute`);
    const policy = /<meta\s+http-equiv="Content-Security-Policy"\s+content="([^"]*)"/i.exec(text);
    if (!policy) problems.push(`${path}: no content policy`);
    else for (const p of policyProblems(policy[1] ?? '')) problems.push(`${path}: ${p}`);
  }
  return problems;
}

/** Holes in a content policy: inline or eval'd code allowed, or script or the network reaching past the app itself. */
export function policyProblems(policy: string): string[] {
  const problems: string[] = [];
  const directives = new Map<string, string[]>();
  for (const part of policy.split(';')) {
    const [name, ...sources] = part.trim().split(/\s+/);
    if (name && !directives.has(name.toLowerCase())) directives.set(name.toLowerCase(), sources.map((s) => s.toLowerCase()));
  }
  for (const [name, sources] of directives) {
    for (const loose of ["'unsafe-inline'", "'unsafe-eval'"]) if (sources.includes(loose)) problems.push(`${name} allows ${loose}`);
  }
  for (const name of ['script-src', 'connect-src']) {
    const sources = directives.get(name) ?? directives.get('default-src');
    if (!sources) problems.push(`${name} is not limited`);
    else if (sources.some((s) => s !== "'self'" && s !== "'none'")) problems.push(`${name} reaches beyond the app`);
  }
  return problems;
}

function readBuild(dir: string): Map<string, string> {
  const files = new Map<string, string>();
  const walk = (at: string) => {
    for (const name of readdirSync(at)) {
      const p = join(at, name);
      if (statSync(p).isDirectory()) walk(p);
      else files.set(relative(dir, p).split(sep).join('/'), TEXT.has(extname(name)) ? readFileSync(p, 'utf8') : '');
    }
  };
  walk(dir);
  return files;
}

if (import.meta.main) {
  const problems = releaseProblems(readBuild('dist'));
  for (const p of problems) console.log(p);
  console.log(problems.length ? `release check: ${problems.length} problem(s)` : 'release check: clean');
  process.exitCode = problems.length ? 1 : 0;
}
