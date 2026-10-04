/**
 * The design gate, run over the screen harness: objective, headless, nothing sent anywhere.
 * Carried from the design lab's gate with its probes and thresholds unchanged; only where the
 * pages come from changed (the harness states in states.mjs, not the preview).
 *
 *   G1  viewport-overflow      horizontal scroll at any viewport
 *   G2  offscreen              visible element outside the viewport box
 *   G3  run-together-text      two text runs on one line with ~no gap
 *   G4  covered-text           text not hit-testable (overlapped / occluded)
 *   G5  clipped-text           scrollWidth/Height exceeds clipped box
 *   G6  contrast-apca          APCA Lc vs required font size for that weight
 *   G7  tap-target             interactive box below 44x44 (24x24 = hard fail)
 *   G8  dead-space             longest run of visually empty pixel rows
 *   G9  scale-drift            distinct font-size / spacing values in use
 *
 * The background for G6 is read from the rendered pixels, so gradients are handled.
 *
 * Usage: node scripts/screens/gate.mjs [id,id…] [--json out.json]   (after npm run screens:build)
 * Exit code 0 = gate passed. 1 = at least one BLOCKER.
 */

import { APCAcontrast, sRGBtoY, fontLookupAPCA } from 'apca-w3';
import fs from 'node:fs';
import path from 'node:path';
import { harness } from './page.mjs';
import { STATES } from './states.mjs';

const CONFIG = {
  viewports: [
    { name: 'phone',   width: 412, height: 915, dsf: 3 },   // Galaxy S-class
    { name: 'phone-s', width: 360, height: 780, dsf: 3 },   // smallest realistic
    { name: 'desktop', width: 1440, height: 900, dsf: 1 },
  ],
  // Declared design system. Anything outside these sets is drift.
  typeScale:    [11, 12, 13, 15, 17, 21, 28, 38, 120, 150],
  spaceScale:   [0, 1, 2, 4, 8, 12, 16, 24, 32, 48, 64, 96],
  // Gaps below this fraction of the font size count as run-together text.
  runTogetherFrac: 0.22,
  runTogetherMinPx: 3,
  // Dead space: flag a vertically empty band longer than this fraction of vh.
  deadSpaceFrac: 0.18,
  tapTargetIdeal: 44,   // Apple HIG / WCAG 2.5.5 AAA
  tapTargetFloor: 24,   // WCAG 2.2 SC 2.5.8 AA
};

const args = process.argv.slice(2);
const argOf = (f) => { const i = args.indexOf(f); return i === -1 ? null : args[i + 1]; };
const only = args[0] && !args[0].startsWith('--') ? args[0].split(',') : null;

// ------------------------------------------------------------ in-page JS ----
// Everything below runs inside the browser. It returns raw measurements only;
// all judgement happens in Node so the thresholds live in one place.
const PROBE = () => {
  const out = { texts: [], boxes: [], interactive: [], clipped: [], offscreen: [], overflow: null };

  const vw = window.innerWidth, vh = window.innerHeight;
  out.overflow = {
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth: vw,
    scrollHeight: document.documentElement.scrollHeight,
  };

  // Paint the colour into one canvas pixel and read it back: exact sRGB for any CSS colour syntax.
  const cv = document.createElement('canvas'); cv.width = cv.height = 1;
  const cx = cv.getContext('2d', { willReadFrequently: true });
  const toSRGB = (c) => {
    if (/^rgba?\(/.test(c)) return c;
    cx.clearRect(0, 0, 1, 1); cx.fillStyle = 'rgba(0,0,0,0)'; cx.fillStyle = c; cx.fillRect(0, 0, 1, 1);
    const d = cx.getImageData(0, 0, 1, 1).data;
    return `rgba(${d[0]}, ${d[1]}, ${d[2]}, ${(d[3] / 255).toFixed(3)})`;
  };

  const visible = (el) => {
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') return false;
    if (parseFloat(cs.opacity) === 0) return false;
    return true;
  };

  const pathOf = (el) => {
    const parts = [];
    for (let n = el; n && n.nodeType === 1 && parts.length < 4; n = n.parentElement) {
      let s = n.tagName.toLowerCase();
      if (n.id) { parts.unshift(s + '#' + n.id); break; }
      if (n.classList.length) s += '.' + [...n.classList].slice(0, 2).join('.');
      parts.unshift(s);
    }
    return parts.join('>');
  };

  // ---- text runs, measured with Range so we get ink boxes not element boxes
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  let node;
  while ((node = walker.nextNode())) {
    const raw = node.nodeValue;
    if (!raw || !raw.trim()) continue;
    const el = node.parentElement;
    if (!el || !visible(el)) continue;
    const tag = el.tagName;
    if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT' || tag === 'TITLE') continue;

    const range = document.createRange();
    range.selectNodeContents(node);
    const rects = [...range.getClientRects()].filter(r => r.width > 0 && r.height > 0);
    if (!rects.length) continue;

    const cs = getComputedStyle(el);
    const fontSize = parseFloat(cs.fontSize);
    const weight = parseInt(cs.fontWeight, 10) || 400;

    for (const r of rects) {
      out.texts.push({
        sel: pathOf(el),
        // length + shape only; never the content itself (journal text is off limits)
        len: raw.trim().length,
        // punctuation hugging an inline <b> ("mornings,") is normal typography, not a collision
        head: /^[\s,.;:!?)\]}'’”…—–-]/.test(raw), tail: /[\s(\[{'‘“—–-]$/.test(raw),
        x: r.x, y: r.y, w: r.width, h: r.height,
        fontSize, weight,
        // computed colours can be oklch()/color(); resolve them to sRGB through a canvas
        color: toSRGB(cs.color),
        letterSpacing: cs.letterSpacing,
        // deliberately stacked? out-of-flow or explicitly z-indexed text is
        // layered on purpose (a label over a big numeral), not a collision.
        outOfFlow: cs.position === 'absolute' || cs.position === 'fixed' ||
                   cs.zIndex !== 'auto' ||
                   (() => { for (let n = el; n && n !== document.body; n = n.parentElement) {
                              const c = getComputedStyle(n);
                              if (c.position === 'absolute' || c.position === 'fixed') return true;
                            } return false; })(),
        // gradient / clipped text paints from background-image, so computed
        // `color` is transparent and useless — sample the glyph pixels instead.
        gradientText: /text/.test(cs.webkitBackgroundClip || cs.backgroundClip || '') ||
                      /rgba\(0, 0, 0, 0\)/.test(cs.webkitTextFillColor || ''),
        // hit test: is anything OPAQUE stacked above this text?
        // A decorative glow at 6% alpha is above it too, and that is fine —
        // only an occluding layer counts.
        covered: (() => {
          const cx = r.x + r.width / 2;
          const cy = r.y + r.height / 2;
          // Do NOT clamp into the viewport. Clamping tested every below-the-fold
          // element against the viewport's bottom edge — where the fixed dock
          // sits — and reported the entire page as occluded. Off-screen means
          // not testable, not covered.
          if (cy < 0 || cy >= vh || cx < 0 || cx >= vw) return null;
          const stack = document.elementsFromPoint(cx, cy);
          const fixedAncestor = (n) => { for (; n && n !== document.body; n = n.parentElement) if (getComputedStyle(n).position === 'fixed') return n; return null; };
          for (const hit of stack) {
            if (hit === el || el.contains(hit) || hit.contains(el)) return false; // reached our own text
            const hcs = getComputedStyle(hit);
            const a = (hcs.backgroundColor.match(/-?[\d.]+/g) || [])[3];
            const opaque = (a === undefined ? hcs.backgroundColor !== 'transparent' : Number(a) >= 0.5);
            if (opaque || hit.tagName === 'IMG' || hit.tagName === 'CANVAS') {
              const fx = fixedAncestor(hit);
              if (fx) {
                // an open modal covers the page beneath it on purpose
                if (document.querySelector('[role="dialog"]')) return null;
                // a bottom bar over text that the page can still scroll clear of it
                const top = fx.getBoundingClientRect().top;
                const room = document.documentElement.scrollHeight - (window.scrollY + vh);
                if (top > vh * 0.5 && room >= (cy - top) + r.height) return null;
              }
              return true;
            }
          }
          return false;
        })(),
      });
    }
  }

  // ---- element geometry: clipping, off-viewport, tap targets, scale drift
  const spacingSeen = {}, fontSeen = {}, radiusSeen = {};
  for (const el of document.querySelectorAll('body *')) {
    if (!visible(el)) continue;
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) continue;
    const cs = getComputedStyle(el);

    for (const p of ['marginTop','marginBottom','marginLeft','marginRight',
                     'paddingTop','paddingBottom','paddingLeft','paddingRight',
                     'gap','rowGap','columnGap']) {
      const v = parseFloat(cs[p]);
      if (Number.isFinite(v) && v !== 0) spacingSeen[v] = (spacingSeen[v] || 0) + 1;
    }
    const fs = parseFloat(cs.fontSize);
    if (Number.isFinite(fs)) fontSeen[fs] = (fontSeen[fs] || 0) + 1;
    const br = parseFloat(cs.borderTopLeftRadius);
    if (Number.isFinite(br) && br !== 0) radiusSeen[br] = (radiusSeen[br] || 0) + 1;

    // clipped content
    const clips = /hidden|clip|auto|scroll/.test(cs.overflowX + cs.overflowY) ||
                  cs.textOverflow === 'ellipsis';
    if (clips) {
      const ox = el.scrollWidth - el.clientWidth;
      const oy = el.scrollHeight - el.clientHeight;
      if (ox > 1 || oy > 1) {
        // overflow made only of decoration (aria-hidden glows, empty shapes) clips nothing a reader needs
        const decorative = [...el.querySelectorAll('*')].filter(d => {
          const dr = d.getBoundingClientRect();
          return dr.right > r.right + 1 || dr.left < r.left - 1 || dr.bottom > r.bottom + 1;
        }).every(d => d.closest('[aria-hidden="true"]') || !(d.textContent || '').trim());
        if (!(decorative && el.children.length && cs.textOverflow !== 'ellipsis'))
          out.clipped.push({ sel: pathOf(el), overflowX: ox, overflowY: oy,
                             scrollable: /auto|scroll/.test(cs.overflowY),
                             // "…" is a visible, deliberate truncation — report it, but it is not a broken layout
                             ellipsis: cs.textOverflow === 'ellipsis' });
      }
    }

    // outside the viewport box horizontally — only meaningful for elements that
    // carry meaning. A decorative glow that bleeds past the edge is intentional.
    const carriesMeaning = (el.textContent || '').trim().length > 0 ||
                           el.matches('a,button,input,select,textarea,img,[role]');
    if (r.width > 0 && carriesMeaning && (r.right > vw + 1 || r.left < -1)) {
      out.offscreen.push({ sel: pathOf(el), left: r.left, right: r.right, vw });
    }

    // tap targets
    const interactiveSel = 'a,button,input,select,textarea,summary,[role=button],[role=link],[role=switch],[role=tab],[role=checkbox],[tabindex]';
    if (el.matches(interactiveSel) && !el.matches('[tabindex="-1"]')) {
      out.interactive.push({ sel: pathOf(el), w: r.width, h: r.height });
    }
  }
  out.scale = { spacingSeen, fontSeen, radiusSeen };
  return out;
};

// ------------------------------------------------- pixel sampling in-page ----
// Draw the screenshot into a canvas and read real pixels: background colour
// under each text run, and rows that contain no painted content.
const SAMPLE = async ({ dataUrl, rects, bgHint }) => {
  const img = new Image();
  await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = dataUrl; });
  const c = document.createElement('canvas');
  c.width = img.naturalWidth; c.height = img.naturalHeight;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0);
  // full-page screenshot: scale from CSS px to image px, and shift viewport-relative
  // rects into document space so below-the-fold text is sampled correctly.
  const sx = img.naturalWidth / document.documentElement.clientWidth;
  const scrollY = window.scrollY;
  const maxY = img.naturalHeight / sx, maxX = img.naturalWidth / sx;
  for (const r of rects) r.y += scrollY;

  const px = (x, y) => {
    const d = ctx.getImageData(Math.round(x * sx), Math.round(y * sx), 1, 1).data;
    return [d[0], d[1], d[2]];
  };
  const median = (arr) => arr.slice().sort((a, b) => a - b)[Math.floor(arr.length / 2)];

  // glyph colour for gradient/clipped text: brightest pixel inside the ink box
  // (light-on-dark), which is the glyph core rather than an antialiased edge.
  const inks = rects.map((r) => {
    if (!r.gradient) return null;
    let best = null, bestL = -1;
    for (let dy = 1; dy < r.h - 1; dy += Math.max(1, Math.floor(r.h / 12)))
      for (let dx = 1; dx < r.w - 1; dx += Math.max(1, Math.floor(r.w / 40))) {
        const x = r.x + dx, y = r.y + dy;
        if (x < 0 || y < 0 || x >= maxX || y >= maxY) continue;
        const p = px(x, y);
        const L = 0.2126 * p[0] + 0.7152 * p[1] + 0.0722 * p[2];
        if (L > bestL) { bestL = L; best = p; }
      }
    return best;
  });

  // background under each text run: median of a band 3px above and below
  const bgs = rects.map((r) => {
    const ys = [r.y - 3, r.y - 2, r.y + r.h + 2, r.y + r.h + 3];
    const xs = [r.x + r.w * 0.15, r.x + r.w * 0.5, r.x + r.w * 0.85];
    const R = [], G = [], B = [];
    for (const y of ys) for (const x of xs) {
      if (y < 0 || y >= maxY || x < 0 || x >= maxX) continue;
      const p = px(x, y); R.push(p[0]); G.push(p[1]); B.push(p[2]);
    }
    if (!R.length) return bgHint;
    return [median(R), median(G), median(B)];
  });

  // dead space: rows whose pixels are all within tolerance of the page ground
  const H = img.naturalHeight, W = img.naturalWidth;
  const full = ctx.getImageData(0, 0, W, H).data;
  const ground = bgHint;
  const emptyRow = new Array(H).fill(false);
  const step = Math.max(1, Math.floor(W / 120));   // sample ~120 columns per row
  for (let y = 0; y < H; y++) {
    let empty = true;
    for (let x = 0; x < W; x += step) {
      const i = (y * W + x) * 4;
      if (Math.abs(full[i] - ground[0]) + Math.abs(full[i+1] - ground[1]) + Math.abs(full[i+2] - ground[2]) > 12) {
        empty = false; break;
      }
    }
    emptyRow[y] = empty;
  }
  let best = { start: 0, len: 0 }, cur = 0;
  for (let y = 0; y < H; y++) {
    if (emptyRow[y]) { cur++; if (cur > best.len) best = { start: y - cur + 1, len: cur }; }
    else cur = 0;
  }
  // ignore a trailing empty band (page simply ends)
  const trailing = best.start + best.len >= H - 2;
  return {
    bgs, inks,
    deadSpace: { startCss: best.start / sx, lenCss: best.len / sx, trailing, pageHeightCss: H / sx },
  };
};

// -------------------------------------------------------------- analysis ----
function parseRgb(s) {
  const m = s.match(/-?[\d.]+/g);
  if (!m) return null;
  const [r, g, b, a] = m.map(Number);
  return { r, g, b, a: a === undefined ? 1 : a };
}
function composite(fg, bg) {   // fg may be translucent; bg is opaque
  const a = fg.a;
  return [Math.round(fg.r * a + bg[0] * (1 - a)),
          Math.round(fg.g * a + bg[1] * (1 - a)),
          Math.round(fg.b * a + bg[2] * (1 - a))];
}
function wcag2(fg, bg) {
  const L = (c) => { const s = c.map(v => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); });
                     return 0.2126 * s[0] + 0.7152 * s[1] + 0.0722 * s[2]; };
  const a = L(fg), b = L(bg);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}
const weightIndex = (w) => Math.min(9, Math.max(1, Math.round(w / 100)));

function analyse(vp, probe, sample) {
  const F = [];
  const add = (gate, level, msg, detail) => F.push({ viewport: vp.name, gate, level, msg, detail });

  // G1 viewport overflow
  const ov = probe.overflow.scrollWidth - probe.overflow.innerWidth;
  if (ov > 1) add('G1 viewport-overflow', 'BLOCKER',
    `page scrolls horizontally by ${ov}px`, probe.overflow);

  // G2 offscreen
  for (const o of probe.offscreen.slice(0, 12))
    add('G2 offscreen', 'BLOCKER', `${o.sel} spans ${Math.round(o.left)}→${Math.round(o.right)} in a ${o.vw}px viewport`, o);

  // G3 run-together text.
  // Baseline-aligned runs of DIFFERENT font sizes have different tops, so line
  // detection must use vertical OVERLAP of the ink boxes, never a y bucket.
  const runs = probe.texts.slice().sort((a, b) => a.x - b.x || a.y - b.y);
  for (let i = 0; i < runs.length; i++) {
    for (let j = i + 1; j < runs.length; j++) {
      const L = runs[i], R = runs[j];
      if (R.x - (L.x + L.w) > 40) break;                       // sorted by x: nothing closer follows
      if (L.sel === R.sel) continue;                           // same element = normal wrapping
      if (L.outOfFlow || R.outOfFlow) continue;                // deliberate layering
      // Same visual line means shared baseline, NOT merely overlapping line
      // boxes: `line-height:.82` on a 120px numeral makes its box collide with
      // the sibling above it while the text sits on a different line entirely.
      const cL = L.y + L.h / 2, cR = R.y + R.h / 2;
      if (Math.abs(cL - cR) > Math.min(L.h, R.h) * 0.35) continue;
      const overlap = Math.min(L.y + L.h, R.y + R.h) - Math.max(L.y, R.y);
      if (overlap < Math.min(L.h, R.h) * 0.5) continue;
      const gap = R.x - (L.x + L.w);
      if (gap < -2) continue;          // deep overlap is a collision, not adjacency
      const need = Math.max(CONFIG.runTogetherMinPx,
                            CONFIG.runTogetherFrac * Math.max(L.fontSize, R.fontSize));
      if (gap < need && !L.tail && !R.head) {
        add('G3 run-together-text', 'BLOCKER',
          `${L.sel} and ${R.sel} share a line with a ${gap.toFixed(1)}px gap ` +
          `(need ≥${need.toFixed(1)}px) — the words will read as one word`,
          { gap: +gap.toFixed(1), need: +need.toFixed(1), left: L.sel, right: R.sel, y: Math.round(L.y) });
      }
    }
  }

  // G4 covered text
  for (const t of probe.texts.filter(t => t.covered === true).slice(0, 12))
    add('G4 covered-text', 'BLOCKER', `${t.sel} is painted but not hit-testable — something is on top of it`, t);

  // G5 clipped text
  for (const c of probe.clipped.filter(c => !c.scrollable).slice(0, 12))
    add('G5 clipped-text', c.ellipsis ? 'MINOR' : 'BLOCKER',
      `${c.sel} clips its own content (${c.overflowX}px x, ${c.overflowY}px y)`, c);

  // G6 contrast (APCA) — the gate WCAG 2 cannot enforce on true black
  const seen = new Set();
  probe.texts.forEach((t, i) => {
    const bg = sample.bgs[i];
    if (!bg) return;
    let fg;
    if (t.gradientText) {
      fg = sample.inks[i];
      if (!fg) return;                       // could not sample; do not guess
    } else {
      const fgc = parseRgb(t.color);
      if (!fgc) return;
      fg = composite(fgc, bg);
    }
    const Lc = Number(APCAcontrast(sRGBtoY(fg), sRGBtoY(bg)));
    const table = fontLookupAPCA(Lc);
    const need = table[weightIndex(t.weight)];
    const key = `${t.gradientText ? 'grad' : t.color}|${fg.join(',')}|${bg.join(',')}|${t.fontSize}|${t.weight}`;
    if (seen.has(key)) return;
    seen.add(key);
    const ratio = wcag2(fg, bg);
    if (need === 999 || need === 777 || t.fontSize < need) {
      add('G6 contrast-apca', need === 999 ? 'BLOCKER' : 'MAJOR',
        `${t.sel}: ${t.fontSize}px/${t.weight} at Lc ${Lc.toFixed(1)} needs ` +
        `${need === 999 ? 'a different colour (prohibited for text)' :
           need === 777 ? 'non-text use only' : `≥${need}px`} ` +
        `— WCAG2 says ${ratio.toFixed(2)}:1 ${ratio >= 4.5 ? '(PASSES AA — false negative)' : '(fails AA)'}`,
        { Lc: +Lc.toFixed(1), need, fontSize: t.fontSize, weight: t.weight,
          fg: `rgb(${fg})`, bg: `rgb(${bg})`, wcag2: +ratio.toFixed(2) });
    }
  });

  // G7 tap targets
  const tapSeen = new Set();
  for (const el of probe.interactive) {
    const min = Math.min(el.w, el.h);
    const key = el.sel + '|' + Math.round(el.w) + 'x' + Math.round(el.h);
    if (tapSeen.has(key)) continue; tapSeen.add(key);
    if (min < CONFIG.tapTargetFloor)
      add('G7 tap-target', 'BLOCKER', `${el.sel} is ${Math.round(el.w)}×${Math.round(el.h)} (WCAG 2.2 floor 24×24)`, el);
    else if (min < CONFIG.tapTargetIdeal && vp.name.startsWith('phone'))
      add('G7 tap-target', 'MAJOR', `${el.sel} is ${Math.round(el.w)}×${Math.round(el.h)} (thumb target 44×44)`, el);
  }

  // G8 dead space
  const ds = sample.deadSpace;
  if (!ds.trailing && ds.lenCss > vp.height * CONFIG.deadSpaceFrac)
    add('G8 dead-space', 'MAJOR',
      `${Math.round(ds.lenCss)}px of empty rows starting at y=${Math.round(ds.startCss)} ` +
      `(${(ds.lenCss / vp.height * 100).toFixed(0)}% of the viewport)`, ds);

  // G9 scale drift
  const fonts = Object.keys(probe.scale.fontSeen).map(Number).sort((a, b) => a - b);
  const offScaleF = fonts.filter(f => !CONFIG.typeScale.includes(f));
  if (offScaleF.length)
    add('G9 scale-drift', 'MINOR', `font sizes off the type scale: ${offScaleF.join(', ')}px`,
      { used: fonts, scale: CONFIG.typeScale });
  const spaces = Object.keys(probe.scale.spacingSeen).map(Number).sort((a, b) => a - b);
  const offScaleS = spaces.filter(s => !CONFIG.spaceScale.includes(s) && Number.isInteger(s));
  if (offScaleS.length)
    add('G9 scale-drift', 'MINOR', `spacing values off the scale: ${offScaleS.join(', ')}px`,
      { used: spaces, scale: CONFIG.spaceScale });

  return F;
}

// ------------------------------------------------------------------ main ----
const h = await harness();
const errors = [];
let findings = [];
const shotDir = path.join('screens-out', 'gate');
fs.mkdirSync(shotDir, { recursive: true });

for (const vp of CONFIG.viewports) {
  const page = await h.page({ ...vp, touch: vp.name.startsWith('phone') }, errors);
  for (const [id, hash] of STATES) {
    if (only && !only.includes(id)) continue;
    await h.open(page, hash);
    await page.waitForTimeout(400);                     // let entry transitions settle
    const probe = await page.evaluate(PROBE);
    const shot = await page.screenshot({ path: path.join(shotDir, `${id}-${vp.name}.png`), fullPage: true });
    const dataUrl = 'data:image/png;base64,' + shot.toString('base64');
    const sample = await page.evaluate(SAMPLE, {
      dataUrl,
      rects: probe.texts.map(t => ({ x: t.x, y: t.y, w: t.w, h: t.h, gradient: t.gradientText })),
      bgHint: [0, 0, 0],
    });
    findings = findings.concat(analyse({ ...vp, name: vp.name }, probe, sample).map(f => ({ ...f, state: id })));
  }
}
await h.close();

// --------------------------------------------------------------- report ----
// collapse repeats (one habit row's bug is every habit row's bug)
const grouped = new Map();
for (const f of findings) {
  const key = `${f.state}|${f.viewport}|${f.gate}|${f.msg.replace(/[\d.]+/g, '#')}`;
  if (grouped.has(key)) { grouped.get(key).n++; continue; }
  grouped.set(key, { ...f, n: 1 });
}
findings = [...grouped.values()];

const order = { BLOCKER: 0, MAJOR: 1, MINOR: 2 };
findings.sort((a, b) => order[a.level] - order[b.level]);
const counts = findings.reduce((m, f) => (m[f.level] = (m[f.level] || 0) + 1, m), {});

for (const f of findings) {
  console.log(`[${f.level.padEnd(7)}] ${f.gate.padEnd(22)} ${f.state.padEnd(14)} ${f.viewport.padEnd(8)} ${f.msg}` +
              (f.n > 1 ? `  (×${f.n})` : ''));
}
for (const e of errors) console.log(`[ERROR  ] ${e}`);
console.log('\n' + '-'.repeat(78));
console.log(`BLOCKER ${counts.BLOCKER || 0}   MAJOR ${counts.MAJOR || 0}   MINOR ${counts.MINOR || 0}   page errors ${errors.length}`);
console.log(`screenshots: ${shotDir}`);

if (argOf('--json')) fs.writeFileSync(argOf('--json'), JSON.stringify(findings, null, 2));
process.exitCode = counts.BLOCKER || errors.length ? 1 : 0;
