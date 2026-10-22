import { test } from 'node:test';
import assert from 'node:assert/strict';
import { aboveDock, centre, dockTop, find, inView, inputTextArg, nodesOf, onScreen, pickerMove, type UiNode } from '../../scripts/android/drive.ts';

const DUMP = `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?><hierarchy rotation="0">
    <node index="0" text="" resource-id="" class="android.widget.FrameLayout" content-desc="" enabled="true" bounds="[0,0][1080,2400]">
      <node index="1" text="Use your passphrase" resource-id="" class="android.widget.Button" content-desc="" enabled="true" bounds="[340,1800][740,1888]" />
      <node index="2" text="" resource-id="" class="android.widget.Button" content-desc="Unlock with fingerprint" enabled="false" bounds="[480,1200][600,1320]" />
      <node index="3" text="Walk &amp; stretch" resource-id="" class="android.view.View" content-desc="" enabled="true" bounds="[48,600][1032,700]" />
    </node></hierarchy>`;

test('a dump\'s nodes, with their words decoded and their bounds', () => {
  const nodes = nodesOf(DUMP);
  assert.equal(nodes.length, 4);
  assert.deepEqual(find(nodes, 'Use your passphrase')?.bounds, [340, 1800, 740, 1888]);
  assert.equal(find(nodes, 'Unlock with fingerprint')?.enabled, false);           // found by content-desc
  assert.equal(find(nodes, 'Walk & stretch')?.cls, 'android.view.View');
  assert.equal(find(nodes, /^Use your/)?.text, 'Use your passphrase');
  assert.equal(find(nodes, 'Nothing like this'), undefined);
  assert.deepEqual(centre(find(nodes, 'Use your passphrase')!), [540, 1844]);
});

test('input text: one argument, spaces as %s, the shell\'s specials escaped, plain ASCII only', () => {
  assert.equal(inputTextArg('CANARY harness passphrase'), 'CANARY%sharness%spassphrase');
  assert.equal(inputTextArg("it's (fine)"), "it\\'s%s\\(fine\\)");
  assert.throws(() => inputTextArg('100%'));
  assert.throws(() => inputTextArg('naïve'));
  // The phone check types this. It has to stay one argument, so the shell cannot see a second command.
  const typed = inputTextArg('CANARY phone test passphrase');
  assert.equal(typed.includes(' '), false);
  assert.doesNotMatch(typed, /[;&|`$()<>\\'"]/);
  assert.equal(typed.split('%s').length, 4);
});

test('a node is on screen only when its bounds have area', () => {
  const nodes = nodesOf(DUMP);
  assert.equal(onScreen(nodes[1]!), true);
  assert.equal(onScreen({ ...nodes[1]!, bounds: [0, 0, 0, 0] }), false);
  assert.equal(inView(nodes[1]!, 1080, 2400), true);
  assert.equal(inView({ ...nodes[1]!, bounds: [48, 2500, 900, 2600] }, 1080, 2400), false);
  assert.equal(inView({ ...nodes[1]!, bounds: [0, 0, 0, 0] }, 1080, 2400), false);
});

function button(text: string, bounds: UiNode['bounds']): UiNode {
  return { text, desc: '', id: '', cls: 'android.widget.Button', bounds, enabled: true };
}

test('a settings row whose centre sits on the dock is on screen and not tappable there', () => {
  // Bounds from the A16 dump: the restore row was enabled and in view, and its centre was on Diary.
  const row = button('Restore from a backup replaces everything on this phone, after asking', [42, 2149, 1042, 2319]);
  const dock = [
    button('Today', [0, 2170, 273, 2339]),
    button('Look back', [270, 2170, 543, 2339]),
    button('Diary', [540, 2170, 813, 2339]),
    button('Plan', [808, 2170, 1080, 2339]),
  ];
  const top = dockTop([row, ...dock], 2400);
  assert.equal(top, 2170);
  assert.equal(inView(row, 1080, 2400), true);
  assert.equal(aboveDock(row, 1080, 2400, top), false);
  assert.equal(aboveDock({ ...row, bounds: [42, 1400, 1042, 1570] }, 1080, 2400, top), true);
  assert.equal(dockTop([button('Today', [40, 200, 200, 280])], 2400), 2400);
  assert.equal(dockTop([button('Choose a file', [40, 400, 400, 480])], 2400), 2400);
});

test('the file picker opens Downloads from the roots drawer before it scrolls', () => {
  assert.equal(pickerMove(['Recent', 'Show roots'], false), 'roots');
  assert.equal(pickerMove(['Downloads', 'Images', 'Show roots'], false), 'downloads');
  assert.equal(pickerMove(['dc-seed.dcbak'], true), 'file');
  assert.equal(pickerMove(['dc-seed'], true), 'file');
  assert.equal(pickerMove(['Recent'], true), 'scroll');
  // The long invented record has its own name; the picker looks for that one only.
  assert.equal(pickerMove(['dc-3year.dcbak'], true, 'dc-3year'), 'file');
  assert.equal(pickerMove(['dc-seed.dcbak'], true, 'dc-3year'), 'scroll');
});
