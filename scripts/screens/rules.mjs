// The binding wellbeing rules, checked on what the app actually draws: its text and its colours.
// screenProblems(page) → a list of problems on the page as it is now; empty when it keeps the rules.
import { FACTUAL, INTERNAL, MORAL, NEVER } from './banned.mjs';

const escape = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const word = w => new RegExp(`(?<![\\p{L}\\p{N}])${escape(w).replace(/ /g, '\\s+')}(?![\\p{L}\\p{N}])`, 'iu');

/** Problems in a piece of drawn text. Exported for the check's own tests. */
export function textProblems(text) {
  const out = [];
  for (const [w, rule] of NEVER) if (word(w).test(text)) out.push(`the word "${w}" (${rule})`);
  let factual = text;
  for (const phrase of FACTUAL) factual = factual.replace(new RegExp(escape(phrase).replace(/ /g, '\\s+'), 'giu'), '');
  for (const [w, rule] of MORAL) if (word(w).test(factual)) out.push(`the word "${w}" (${rule})`);
  if (text.includes('!')) out.push('an exclamation mark (§8 #37)');
  if (text.includes('%')) out.push('a percentage (§8 #37)');
  if (/\p{Extended_Pictographic}/u.test(text)) out.push('an emoji (§8 #37)');
  for (const f of INTERNAL) if (text.includes(f)) out.push(`the internal flag ${f} (§8)`);
  return out;
}

/** Elements outside the diary's delete confirm drawn in red: OKLCH hue 0–40° with chroma above 0.08 (§8 #7). */
async function redElements(page) {
  return page.evaluate(() => {
    const cv = document.createElement('canvas');
    cv.width = cv.height = 1;
    const ctx = cv.getContext('2d', { willReadFrequently: true });
    const lin = c => { const v = c / 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
    const red = css => {
      if (!css || css === 'transparent' || /rgba\([^)]*,\s*0\)$/.test(css)) return false;
      ctx.clearRect(0, 0, 1, 1);
      ctx.fillStyle = '#000';
      ctx.fillStyle = css;
      ctx.fillRect(0, 0, 1, 1);
      const [r8, g8, b8, a8] = ctx.getImageData(0, 0, 1, 1).data;
      if (a8 < 26) return false;                              // under a tenth opaque: not a colour anyone sees
      const [r, g, b] = [lin(r8), lin(g8), lin(b8)];
      const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
      const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
      const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
      const A = 1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s;
      const B = 0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s;
      const chroma = Math.hypot(A, B);
      const hue = (Math.atan2(B, A) * 180 / Math.PI + 360) % 360;
      return chroma > 0.08 && hue <= 40;
    };
    const found = [];
    for (const root of [document.getElementById('app'), document.getElementById('layer')]) {
      for (const el of root ? root.querySelectorAll('*') : []) {
        if (el.closest('.btn--delete')) continue;
        const cs = getComputedStyle(el);
        if (cs.visibility === 'hidden' || cs.display === 'none') continue;
        if (red(cs.color) && el.textContent?.trim()) found.push(`${el.tagName.toLowerCase()}${el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\s+/).join('.') : ''} text`);
        else if (red(cs.backgroundColor)) found.push(`${el.tagName.toLowerCase()}${el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\s+/).join('.') : ''} background`);
      }
    }
    return found.slice(0, 5);
  });
}

export async function screenProblems(page) {
  const text = await page.evaluate(() => [document.getElementById('app'), document.getElementById('layer')].map(e => e?.innerText ?? '').join('\n'));
  return [...textProblems(text), ...(await redElements(page)).map(e => `red outside the diary's delete: ${e} (§8 #7)`)];
}
