// Shared by the screen checks: the browser, the harness served, and opening one state.
import { chromium } from 'playwright-core';
import { serve } from './serve.mjs';

export async function harness() {
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
    return p;
  }
  /** opens a harness state and waits until the page says it is drawn */
  async function open(p, hash) {
    await p.goto('about:blank');
    await p.goto(`${server.url}/#${hash}`);
    await p.waitForSelector('[data-harness-ready]', { state: 'attached', timeout: 20_000 });
    await p.evaluate(() => document.fonts.ready);
  }
  async function close() {
    await browser.close();
    await server.close();
  }
  return { page, open, close };
}
