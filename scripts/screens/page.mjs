// Shared by the screen checks: the browser, the harness served, and opening one state.
import { chromium } from 'playwright-core';
import { serve } from './serve.mjs';
import { screenProblems } from './rules.mjs';

/**
 * The harness. With `rules`, every tap, click and fill is followed by the wellbeing-rules check on
 * what is then drawn, and each new problem goes into the page's `errors` with the step that showed it.
 */
export async function harness({ rules = false } = {}) {
  const server = await serve('dist-harness');
  const browser = await chromium.launch();
  /** a new page at one size, in UTC, collecting page errors into `errors` */
  async function page(size, errors) {
    const ctx = await browser.newContext({
      viewport: { width: size.width, height: size.height }, deviceScaleFactor: size.dsf ?? 1,
      hasTouch: !!size.touch, isMobile: !!size.touch, colorScheme: 'dark', timezoneId: 'UTC', reducedMotion: 'reduce',
    });
    const p = await ctx.newPage();
    p.on('pageerror', e => errors.push(`${size.name} page error: ${e.message}`));
    p.on('console', m => { if (m.type() === 'error') errors.push(`${size.name} console: ${m.text()}`); });
    if (rules) {
      const seen = new Set();
      const sweep = async step => {
        for (const problem of await screenProblems(p).catch(() => [])) {
          const line = `${size.name} rules: ${problem}, after ${step}`;
          if (!seen.has(problem)) { seen.add(problem); errors.push(line); }
        }
      };
      for (const name of ['tap', 'click', 'fill']) {
        const act = p[name].bind(p);
        p[name] = async (selector, ...rest) => { const r = await act(selector, ...rest); await sweep(`${name} ${selector}`); return r; };
      }
      p.sweep = sweep;
    }
    return p;
  }
  /** opens a harness state and waits until the page says it is drawn */
  async function open(p, hash) {
    await p.goto('about:blank');
    await p.goto(`${server.url}/#${hash}`);
    await p.waitForSelector('[data-harness-ready]', { state: 'attached', timeout: 20_000 });
    await p.evaluate(() => document.fonts.ready);
    await p.sweep?.(`open ${hash}`);
  }
  async function close() {
    await browser.close();
    await server.close();
  }
  return { page, open, close };
}
