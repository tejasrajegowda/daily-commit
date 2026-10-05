import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { EVENING_FROM } from '../../src/today/todayView.ts';
import { checkinLines, dayLines, MORNING_UNTIL, SETTINGS_WORDS, sizeWords, whenWords } from '../../src/settings/settingsWords.ts';
import type { CueRecord, Settings } from '../../src/record/model.ts';

const SETTINGS: Settings = { tz: 'Asia/Kolkata', boundary: 240, journeyStart: '2026-01-05', wakePlan: 390, lightsOutPlan: 1380, cuesOn: true };

/** every string Settings can show, with sample arguments for the ones made from values */
function allWords(): string[] {
  const out: string[] = [];
  const walk = (v: unknown) => {
    if (typeof v === 'string') out.push(v);
    else if (typeof v === 'function') walk((v as (a: string) => unknown)('sample'));
    else if (v && typeof v === 'object') Object.values(v).forEach(walk);
  };
  walk(SETTINGS_WORDS);
  for (const l of dayLines(SETTINGS)) out.push(l.nm, l.sub);
  for (const f of ['Secret.tsx', 'Settings.tsx']) out.push(readFileSync(join(import.meta.dirname, '..', '..', 'src', 'settings', f), 'utf8'));
  return out;
}

test('Settings has no stale lines from the design rounds, and no exclamation marks or percentages', () => {
  for (const w of allWords()) {
    for (const stale of ['Clock app', '60 seconds', 'export once a week']) assert.ok(!w.includes(stale), `stale: ${stale}`);
  }
  for (const w of allWords().slice(0, -2)) assert.ok(!/[!%]/.test(w), `"${w}"`);
});

test("Settings' morning ends where Today's does", () => {
  assert.equal(MORNING_UNTIL, EVENING_FROM);
});

test('the day lines follow the boundary', () => {
  assert.equal(dayLines(SETTINGS)[0]?.nm, 'A day ends at 04:00');
  assert.match(dayLines(SETTINGS)[0]?.sub ?? '', /a 00:30 lights out/);
  assert.equal(dayLines({ ...SETTINGS, boundary: 300 })[0]?.nm, 'A day ends at 05:00');
});

test('check-ins: only enabled ones, earliest first; a private one shows no words', () => {
  const cue = (id: string, at: number, extra: Partial<CueRecord> = {}): CueRecord =>
    ({ id, habitId: null, kind: 'checkin', text: `CANARY-TEST ${id}`, times: { at: [at] }, enabled: true, createdOn: '2026-01-05', private: false, ...extra });
  const lines = checkinLines([cue('b', 1365), cue('a', 360), cue('c', 600, { enabled: false }), cue('d', 1200, { private: true })]);
  assert.deepEqual(lines.map(l => l.nm), ['Morning · 06:00', 'Evening · 20:00', 'Evening · 22:45']);
  assert.equal(lines[1]?.sub, 'shows only "Daily Commit"');
});

test('sizes and times read plainly', () => {
  assert.equal(sizeWords(2.4 * 1024 * 1024), '2.4 MB');
  assert.equal(sizeWords(640 * 1024), '640 KB');
  const now = Date.parse('2026-09-20T08:32:00Z');               // 14:02 in Kolkata
  assert.equal(whenWords(now - 60_000, now, 'Asia/Kolkata'), 'today, 14:01');
  assert.equal(whenWords(now - 86_400_000, now, 'Asia/Kolkata'), 'Saturday 19 September, 14:02');
});
