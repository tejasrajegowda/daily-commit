// Screenshots of every harness state at both sizes, into screens-out/shots/<id>-<size>.png.
// node scripts/screens/shots.mjs [id,id…] [--full]
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { harness } from './page.mjs';
import { SIZES, STATES } from './states.mjs';

const OUT = join('screens-out', 'shots');
mkdirSync(OUT, { recursive: true });
const only = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2].split(',') : null;
const full = process.argv.includes('--full');
const h = await harness();
const errors = [];
let n = 0;
for (const size of SIZES) {
  const p = await h.page(size, errors);
  for (const [id, hash] of STATES) {
    if (only && !only.includes(id)) continue;
    await h.open(p, hash);
    await p.waitForTimeout(250);
    await p.screenshot({ path: join(OUT, `${id}-${size.name}.png`), fullPage: full });
    n++;
  }
}
await h.close();
console.log(`${n} screenshots in ${OUT}`);
console.log(errors.length ? errors.join('\n') : 'no page errors');
process.exitCode = errors.length ? 1 : 0;
