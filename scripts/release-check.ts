// Checks the release build in dist/ after `vite build`: nothing from the screen harness may be in
// it, and its pages keep the content policy (no inline script or style). Run by `npm run build`.
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
    if (!/<meta\s+http-equiv="Content-Security-Policy"/i.test(text)) problems.push(`${path}: no content policy`);
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
