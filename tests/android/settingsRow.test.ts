import { test } from 'node:test';
import assert from 'node:assert/strict';
import { diaryLayout, settingsRow, settingsSections } from '../../scripts/android/checks/a.ts';
import type { Emu, UiNode } from '../../scripts/android/drive.ts';

// On a wide screen (the tablet lying sideways, 16 Nov) Settings shows one section at a time; the phone shows one long
// page. A row is reached by opening its section first there, and by scrolling here.

const node = (text: string, bounds: readonly [number, number, number, number], cls = 'android.widget.Button'): UiNode =>
  ({ pkg: 'app.dailycommit', cls, text, desc: '', enabled: true, clickable: true, bounds }) as unknown as UiNode;

const SECTIONS = ['Day and time', 'Display', 'Privacy', 'Your data', 'Pause', 'About'];
const PANEL: Record<string, readonly string[]> = { 'Day and time': ['Your day starts'], Privacy: ["Your phone's lock", 'A separate code'], 'Your data': ['Restore from a backup', 'kept in the app'] };

function wideSettings() {
  let section = 'Day and time';
  const taps: string[] = [];
  const nodes = () => [
    node('', [0, 0, 2304, 1440], 'android.widget.FrameLayout'),
    ...SECTIONS.map((s, i) => node(s, [40, 200 + i * 60, 280, 250 + i * 60])),
    ...(PANEL[section] ?? []).map((r, i) => node(r, [400, 300 + i * 90, 1100, 370 + i * 90])),
  ];
  const phone = {
    dump: nodes,
    shell: (c: string) => ({ code: 0, out: c === 'wm size' ? 'Physical size: 1440x2304' : '' }),
    tap(label: string | RegExp) {
      const hit = nodes().find(n => (typeof label === 'string' ? n.text === label : label.test(n.text)));
      if (!hit) throw new Error('not on screen');
      taps.push(hit.text);
      if (SECTIONS.includes(hit.text)) section = hit.text;
    },
  } as unknown as Emu;
  return { phone, taps, section: () => section };
}

test('a wide Settings lists its sections; a phone\'s long page has none to open', () => {
  assert.deepEqual(settingsSections(wideSettings().phone.dump()), SECTIONS);
  const phonePage = [node('Privacy', [40, 500, 500, 580], 'android.widget.TextView'), node('Your data', [40, 900, 500, 980], 'android.widget.TextView')];
  assert.deepEqual(settingsSections(phonePage), []);
});

test('on a wide Settings the row\'s section is opened before the row is looked for', () => {
  const w = wideSettings();
  settingsRow(w.phone, /Your phone's lock/);
  assert.equal(w.section(), 'Privacy');
  assert.deepEqual(w.taps, ['Day and time', 'Display', 'Privacy']);
  const again = wideSettings();
  settingsRow(again.phone, /Your day starts/);
  assert.deepEqual(again.taps, [], 'a row already showing opens nothing');
});

test('the diary is recognised on a phone (Earlier, Not yet) and on a wide screen (its list of pages beside it)', () => {
  assert.equal(diaryLayout([node('Earlier', [800, 180, 1000, 240])]), 'phone');
  assert.equal(diaryLayout([node('Not yet', [600, 180, 780, 240])]), 'phone');
  // wide: "Not yet" is a list row whose name runs on, and Earlier is a phone-only button
  assert.equal(diaryLayout([node('newest first', [500, 200, 700, 240], 'android.widget.TextView'), node("Not yet Things you're thinking about", [40, 900, 700, 980])]), 'wide');
  assert.equal(diaryLayout([node('Today', [40, 200, 300, 260])]), undefined);
});