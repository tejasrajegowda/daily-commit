// The click-through test of the real app, in the screen harness. Invented data only.
// node scripts/screens/flows.mjs (after npm run screens:build) → PASS/FAIL lists, exit 1 on any FAIL.
import { harness } from './page.mjs';
import { SIZES } from './states.mjs';

const h = await harness();
const errors = [];
const ok = [];
const check = (name, cond) => (cond ? ok : errors).push(name);
const [PHONE, LAPTOP] = SIZES;

// the harness itself
{
  const p = await h.page(PHONE, errors);
  await h.open(p, 's=today');
  check('the harness page draws', (await p.locator('[data-harness-ready]').count()) === 1);
  check('nothing is kept in localStorage', await p.evaluate(() => localStorage.length === 0));
  const q = await h.page(LAPTOP, errors);
  await h.open(q, 's=today&t=21:30&age=60');
  check('the harness draws at laptop size, on day 60', (await q.locator('[data-harness-ready]').count()) === 1);
}

await h.close();
console.log(`PASS ${ok.length}\n  ${ok.join('\n  ')}`);
console.log(errors.length ? `FAIL ${errors.length}\n  ${errors.join('\n  ')}` : 'FAIL 0');
process.exitCode = errors.length ? 1 : 0;
