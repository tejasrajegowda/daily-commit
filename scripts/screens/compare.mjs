// The app beside the design preview: each of the preview's states at both sizes, shot in the preview and in the
// harness drawing the preview's own record, with the share of pixels that differ (odiff) and the pair side by side
// in screens-out/compare/<id>-<size>.png, for reading by eye.
//   PREVIEW_DIR=<the preview's folder> node scripts/screens/compare.mjs [id,id…]
// The preview's folder holds app.html and tools/preview-fixture.json. Neither is in this repo, and the record is
// handed to the page at run time (window.harnessFixture), so it never enters dist-harness/.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright-core';
import { compare } from 'odiff-bin';
import { harness } from './page.mjs';
import { SIZES } from './states.mjs';

const dir = process.env.PREVIEW_DIR;
if (!dir || !existsSync(join(dir, 'app.html')) || !existsSync(join(dir, 'tools', 'preview-fixture.json'))) {
  console.error('PREVIEW_DIR must name the preview\'s folder, with app.html and tools/preview-fixture.json');
  process.exit(2);
}
const fixture = JSON.parse(readFileSync(join(dir, 'tools', 'preview-fixture.json'), 'utf8'));
const PREVIEW = pathToFileURL(resolve(dir, 'app.html')).href;

const click = sel => async p => { await p.click(sel); await p.waitForTimeout(300); };
const steps = (...fns) => async p => { for (const f of fns) await f(p); };
const passphrase = async p => { await p.fill('input.pass', 'CANARY river stone lamp cloud'); };
const codeShown = async p => { await p.waitForSelector('[data-a="code"]', { timeout: 20_000 }); };

/** [id, the preview's hash, the harness's hash, what to do in the harness first]; the preview's list (tools/preview/shots.mjs) */
const PAIRS = [
  ['lock', 's=lock&t=06:05', 's=lock&t=06:05'],
  ['lockown', 's=lock&v=own&t=06:05', 's=lock&v=own&t=06:05'],
  ['first1', 's=first&v=1&t=13:00', 's=first&t=13:00'],
  ['first2', 's=first&v=2&t=13:00', 's=first&t=13:00', click('[data-a="fstep"]')],
  ['first3', 's=first&v=3&t=13:00', 's=first&t=13:00', steps(click('[data-a="fstep"]'), passphrase, click('[data-a="fstep"]'), codeShown)],
  ['first4', 's=first&v=4&t=13:00', 's=first&t=13:00', steps(click('[data-a="fstep"]'), passphrase, click('[data-a="fstep"]'), codeShown, click('[data-a="fstep"]'))],
  ['saturday', 's=today&t=10:30&age=20', 's=today&t=10:30&age=20'],
  ['month', 's=month&t=12:30&age=60', 's=month&t=12:30&age=60'],
  ['look60', 's=look&t=12:30&age=60', 's=look&t=12:30&age=60'],
  ['morning', 's=today&t=06:48', 's=today&t=06:48'],
  ['study', 's=today&t=08:40', 's=today&t=08:40'],
  ['sheet', 's=today&v=sheet&t=07:05', 's=today&t=07:05', click('[data-a="sheet"]')],
  ['evening', 's=today&t=21:30', 's=today&t=21:30'],
  ['hard', 's=today&v=hard&t=21:30', 's=today&v=hard&t=21:30'],
  ['closed', 's=today&t=22:58', 's=today&t=22:58'],
  ['diary', 's=diary&t=22:20', 's=diary&t=22:20'],
  ['look', 's=look&t=12:30', 's=look&t=12:30'],
  ['look120', 's=look&t=12:30&age=120', 's=look&t=12:30&age=120'],
  ['look1', 's=look&t=12:30&age=1', 's=look&t=12:30&age=1'],
  ['habit', 's=habit&t=12:30', 's=habit&v=up&t=12:30'],
  ['week', 's=week&t=10:30', 's=week&t=10:30'],
  ['plan', 's=plan&t=13:00', 's=plan&t=13:00'],
  ['edit', 's=plan&v=edit&t=13:00', 's=plan&t=13:00', click('.slot[data-x="study"]')],
  ['notyet', 's=notyet&t=22:30', 's=notyet&t=22:30'],
  ['settings', 's=settings&t=13:00', 's=settings&t=13:00'],
  ['privacy', 's=settings&cat=privacy&t=13:00', 's=settings&v=privacy&t=13:00'],
  ['support', 's=support&t=23:10', 's=support&t=23:10'],
];
/** the preview's states with nothing to compare, on the plan's grounds (Task 11 item 3) */
const OUT_OF_SCOPE = { home: "the phone's own home screen", dgate: 'the laptop diary gate (Beta 2)' };

const OUT = join('screens-out', 'compare');
mkdirSync(join(OUT, 'raw'), { recursive: true });
const only = process.argv[2]?.split(',');
const errors = [];
const h = await harness();
const browser = await chromium.launch();
const lines = [];
for (const size of SIZES) {
  const app = await h.page(size, errors);
  await app.addInitScript(fx => { window.harnessFixture = fx; }, fixture);
  const ctx = await browser.newContext({
    viewport: { width: size.width, height: size.height }, deviceScaleFactor: size.dsf ?? 1,
    hasTouch: !!size.touch, isMobile: !!size.touch, colorScheme: 'dark', timezoneId: 'UTC', reducedMotion: 'reduce',
  });
  const pre = await ctx.newPage();
  pre.on('pageerror', e => errors.push(`${size.name} preview error: ${e.message}`));
  const board = await ctx.newPage();
  for (const [id, preHash, appHash, before] of PAIRS) {
    if (only && !only.includes(id)) continue;
    const a = join(OUT, 'raw', `${id}-${size.name}-preview.png`);
    const b = join(OUT, 'raw', `${id}-${size.name}-app.png`);
    await pre.goto('about:blank');
    await pre.goto(`${PREVIEW}#${preHash}`, { waitUntil: 'load' });
    await pre.evaluate(() => document.fonts.ready);
    await pre.waitForTimeout(350);
    await pre.screenshot({ path: a });
    await h.open(app, appHash);
    try { await before?.(app); } catch (e) { errors.push(`${size.name} ${id}: ${e.message.split('\n')[0]}`); }
    await app.waitForTimeout(250);
    await app.screenshot({ path: b });
    const diff = await compare(a, b, join(OUT, 'raw', `${id}-${size.name}-diff.png`), { antialiasing: true, threshold: 0.1 });
    const share = diff.match ? 0 : diff.reason === 'pixel-diff' ? diff.diffPercentage : 100;
    lines.push(`${id}\t${size.name}\t${share.toFixed(1)}`);
    // the pair side by side, preview on the left, at the size it was shot
    const w = size.width, src = f => `data:image/png;base64,${readFileSync(f).toString('base64')}`;
    await board.setViewportSize({ width: w * 2 + 24, height: size.height + 28 });
    await board.setContent(`<body style="margin:0;background:#333;font:13px sans-serif;color:#ddd">
      <div style="display:flex;gap:24px"><div>preview ${id} ${size.name}</div><div style="margin-left:auto">app · ${share.toFixed(1)} per cent differ</div></div>
      <div style="display:flex;gap:24px;margin-top:10px"><img src="${src(a)}" width="${w}"><img src="${src(b)}" width="${w}"></div></body>`);
    await board.screenshot({ path: join(OUT, `${id}-${size.name}.png`) });
  }
  await ctx.close();
}
await browser.close();
await h.close();
writeFileSync(join(OUT, 'report.tsv'), `id\tsize\tchanged per cent\n${lines.join('\n')}\n`);
console.log(`${lines.length} pairs in ${OUT}; not compared: ${Object.entries(OUT_OF_SCOPE).map(([k, v]) => `${k} (${v})`).join(', ')}`);
console.log(errors.length ? errors.join('\n') : 'no page errors');
process.exitCode = errors.length ? 1 : 0;
