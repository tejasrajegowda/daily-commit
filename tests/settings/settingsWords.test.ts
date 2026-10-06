import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { EVENING_FROM } from '../../src/today/todayView.ts';
import {
  checkinLines, dayLines, MORNING_UNTIL, notVerifiedPath, notVerifiedVariant, notVerifiedWords, SETTINGS_WORDS, sizeWords, SUPPORT_WORDS, whenWords, type NotVerifiedPath,
} from '../../src/settings/settingsWords.ts';
import { PAUSED_WORDS } from '../../src/app/pausedWords.ts';
import type { CueRecord, Settings } from '../../src/record/model.ts';
import type { DeviceMode } from '../../src/vault/plugin.ts';

const PATHS: readonly NotVerifiedPath[] = ['new-code', 'code-change', 'phone-lock', 'fingerprint'];
const MODES: readonly (readonly DeviceMode[])[] = [[], ['phone-lock'], ['own-code'], ['own-code', 'fingerprint'], ['fingerprint']];

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
  walk(SUPPORT_WORDS);
  walk(PAUSED_WORDS);
  for (const l of dayLines(SETTINGS)) out.push(l.nm, l.sub);
  for (const p of PATHS) for (const m of MODES) out.push(...Object.values(notVerifiedWords(p, m)));
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

test('a way of opening the phone could not confirm: each path is named by its own Settings variant', () => {
  for (const p of PATHS) assert.equal(notVerifiedPath(notVerifiedVariant(p)), p);
  for (const v of ['notverified', 'privacy', '', 'notverified-other']) assert.equal(notVerifiedPath(v), undefined, v);
});

test("a first code not confirmed: the phone's lock, which was the way in, still opens it", () => {
  const w = notVerifiedWords('new-code', ['phone-lock']);
  assert.equal(w.title, "The code wasn't set");
  assert.equal(w.text, "The phone couldn't confirm the new code, so it wasn't kept. Nothing else was changed. Your phone's lock and your passphrase still open Daily Commit. Set it up again whenever you like.");
  assert.match(notVerifiedWords('new-code', []).text, /For now only your passphrase opens Daily Commit\./);   // after a restore no copy is left
});

test('a changed code not confirmed: the old code is gone too, and only the passphrase opens it', () => {
  const w = notVerifiedWords('code-change', ['fingerprint']);
  assert.equal(w.title, 'The separate code is off');
  assert.equal(w.text, "The phone couldn't confirm the new code, so it wasn't kept. The old code had already been replaced, so it no longer opens Daily Commit. The fingerprint works only beside a code, so it is off too. For now only your passphrase opens Daily Commit. Set a code again whenever you like.");
  assert.ok(!notVerifiedWords('code-change', []).text.includes('fingerprint'));
  assert.ok(!notVerifiedWords('code-change', []).text.includes("phone's lock"));
});

test("the phone's lock not confirmed from own-code mode: the code is still on, and says so", () => {
  const w = notVerifiedWords('phone-lock', ['own-code', 'fingerprint']);
  assert.equal(w.title, "The phone's lock wasn't set up");
  assert.equal(w.text, "The phone couldn't confirm its lock, so nothing was changed. Your code, the fingerprint and your passphrase still open Daily Commit. You can try again whenever you like.");
  assert.ok(!/code is off|lock and your passphrase still/.test(w.text));
});

test("the fingerprint not confirmed: the code still opens it, and the phone's lock is never named", () => {
  const w = notVerifiedWords('fingerprint', ['own-code']);
  assert.equal(w.title, 'Fingerprint is still off');
  assert.equal(w.text, "The phone couldn't confirm the fingerprint, so nothing was changed. Your code and your passphrase still open Daily Commit. You can try again whenever you like.");
  assert.ok(!w.text.includes("phone's lock"));
});

test('every note says the passphrase still opens it', () => {
  for (const p of PATHS) for (const m of MODES) assert.match(notVerifiedWords(p, m).text, /passphrase/, `${p} ${m.join(',')}`);
});
