import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  aboutOrder, changeVersions, clockReadback, clockStamp, dateSetArg, dateSetCommands, dayNumberFrom, nameBox, namePoint,
  installWhy, patchAppVersion, patchChanges, patchPackageVersion, preupgradeNames, recoveryFromLabels,
  REHEARSAL_DAY, todayClosed, versionIs, yesterdayClosed,
} from '../../scripts/android/checks/u6Read.ts';

const GROUPS = ['01234', '56789', 'ABCDE', 'FGHJK', 'MNPQR', 'STVWX', 'YZ012', '34567'];
const CODE = `${GROUPS.join('') }U`;

test('the rehearsal clock argument is the toybox form, and a bad date is refused', () => {
  assert.equal(dateSetArg(1, 5, 20, 0, 2026), '010520002026.00');
  assert.equal(dateSetArg(1, 6, 20, 0, 2026), '010620002026.00');
  assert.deepEqual(dateSetCommands('010520002026.00'), ['date 010520002026.00', 'toybox date 010520002026.00']);
  assert.equal(clockStamp(1, 5, 20), '2026-01-05T20');
  assert.equal(clockReadback('2026-01-05T20\n', '2026-01-05T20'), true);
  assert.equal(clockReadback('2026-01-05T21\n', '2026-01-05T20'), false);
  for (const bad of [[0, 5, 20, 0, 2026], [1, 32, 20, 0, 2026], [1, 5, 24, 0, 2026], [1, 5, 20, 60, 2026], [1, 5, 20, 0, 20]]) {
    const [month, day, hour, minute, year] = bad as [number, number, number, number, number];
    assert.throws(() => dateSetArg(month, day, hour, minute, year), RangeError);
  }
});

test('a recovery code is read from one label or from eight groups and a check', () => {
  const spaced = `${GROUPS.join(' ')} U`;
  assert.equal(recoveryFromLabels([spaced]), CODE);
  assert.equal(recoveryFromLabels(['Your recovery code', ...GROUPS, 'U', "I've written it down"]), CODE);
  assert.equal(recoveryFromLabels(['Daily Commit', 'Begin']), undefined);
  assert.equal(recoveryFromLabels(['01234']), undefined);
});

test('Day N is read from the look-back line and from two nodes, and a settings label is not a day', () => {
  assert.equal(REHEARSAL_DAY, 2);
  assert.equal(dayNumberFrom(['Day 2 · no things in focus']), 2);
  assert.equal(dayNumberFrom(['Monday 5 January', 'Day', '2']), 2);
  assert.equal(dayNumberFrom(['Day and time', 'Day 1']), 1);
  assert.equal(dayNumberFrom(['Day and time']), undefined);
});

test('a closed today and a closed yesterday are different buttons', () => {
  assert.equal(todayClosed(["That's the day.", 'Open today again']), true);
  assert.equal(todayClosed(["That's the day.", 'Open it again']), false);
  assert.equal(yesterdayClosed(["That's the day.", 'Open it again']), true);
  assert.equal(yesterdayClosed(['Yesterday', 'Open today again']), false);
});

test('About lists 0.1.1 before 0.1.0, and a heading or a swapped pair is not a pass', () => {
  const yes = ['Daily Commit', 'What changed', '0.1.1', 'Rehearsal build.', '0.1.0', 'The first version on this phone.'];
  assert.equal(aboutOrder(yes), 'yes');
  assert.equal(aboutOrder(['What changed', '0.1.1 Rehearsal build.', '0.1.0 The first version on this phone.']), 'yes');
  assert.deepEqual(changeVersions(['Day and time', 'version 0.1.1', '0.1.1', '0.1.0']), ['0.1.1', '0.1.0']);
  assert.equal(aboutOrder(['0.1.1', '0.1.0']), 'missing');
  // as the phone read it on the emulator: About's own version line first, then the list as one run of text
  assert.equal(aboutOrder(['ABOUT', 'version 0.1.1', 'WHAT CHANGED', '0.1.1Rehearsal build.0.1.0The first version on this phone.', 'WHAT THE LOCK CAN NOT DO']), 'yes');
  assert.equal(aboutOrder(['version 0.1.1', 'WHAT CHANGED', '0.1.0The first version on this phone.0.1.1Rehearsal build.']), 'order');
  assert.equal(aboutOrder(['version 0.1.1', '0.1.0', 'WHAT CHANGED', '0.1.1Rehearsal build.']), 'missing');  // a version before the heading does not count
  assert.equal(aboutOrder(['WHAT CHANGED', '0.1.1 Rehearsal build.', '0.1.0 The first version on this phone.']), 'yes');  // the phone reads an eyebrow in capitals
  assert.equal(aboutOrder(['What changed', '0.1.0', '0.1.1']), 'order');
  assert.equal(aboutOrder(['What changed', 'Day and time']), 'missing');
});

test('a habit tap uses the name, and a tall row is tapped near its top', () => {
  const name = { text: 'Walk', left: 80, top: 900, right: 400, bottom: 980 };
  const row = { text: 'Walk did · partly · not · every day · evening', left: 0, top: 1900, right: 1080, bottom: 2600 };
  const picked = nameBox([row, name], /^Walk\b/, 2100, 1080, 2400);
  assert.equal(picked, name);
  assert.deepEqual(namePoint(name, 2100), [240, 940]);
  assert.deepEqual(namePoint(row, 2100), [540, 1936]);
  assert.equal(nameBox([row], /^Walk\b/, 1800, 1080, 2400), undefined);
  assert.equal(nameBox([{ text: 'Day and time', left: 80, top: 100, right: 400, bottom: 180 }], /^Walk\b/, 2100, 1080, 2400), undefined);
});

test('a pre-upgrade copy is a 13-digit name, and nothing else counts', () => {
  assert.deepEqual(preupgradeNames(['1735689600000.json.gz', 'preupgrade/1234567890123.json.gz', 'latest.dcbak', '123.json.gz', '']), ['1735689600000.json.gz', '1234567890123.json.gz']);
  assert.deepEqual(preupgradeNames(['No such file or directory']), []);
});

test('an install is yes, or a fixed reason, and the rehearsal edits only the first version', () => {
  assert.equal(installWhy('Installed on emulator-5556, over what was there.\n', 0), 'yes');
  assert.equal(installWhy('signed with a different key from the app already on the phone', 1), 'signer');
  assert.equal(installWhy('This APK is an older version than the one already on the phone.', 1), 'older');
  assert.equal(installWhy("This APK's version code is 100, not 101 from 0.1.1.", 1), 'version');
  assert.equal(installWhy('The install did not succeed.', 1), 'refused');
  assert.equal(installWhy('Installed on emulator-5556, over what was there.\n', 1), 'refused');
  assert.equal(versionIs('{"version":"0.1.0"}\n', '0.1.0'), true);
  assert.equal(versionIs('{"version":"0.1.1"}\n', '0.1.0'), false);
  const pkg = '{\n  "version": "0.1.0",\n  "inner": "version: 0.1.0"\n}\n';
  assert.equal(patchPackageVersion(pkg), '{\n  "version": "0.1.1",\n  "inner": "version: 0.1.0"\n}\n');
  assert.equal(patchAppVersion("export const APP_VERSION = '0.1.0';\n"), "export const APP_VERSION = '0.1.1';\n");
  const changes = "export const CHANGES: readonly Change[] = [\r\n  { version: '0.1.0', line: 'The first version on this phone.' },\r\n];\r\n";
  const patched = patchChanges(changes);
  assert.equal(patched?.startsWith("export const CHANGES: readonly Change[] = [\r\n  { version: '0.1.1', line: 'Rehearsal build.' },\r\n"), true);
  assert.equal(patchChanges('no list'), undefined);
  assert.equal(patchPackageVersion('no version'), undefined);
});

// A regex written through a tool once came out with a backspace where \b was meant, so it never matched
test('the rehearsal scripts hold no control characters (a lost word boundary in a pattern is one)', () => {
  for (const file of ['scripts/android/checks/u6.ts', 'scripts/android/checks/u6Read.ts']) {
    const text = readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8');
    assert.equal(/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(text), false, file);
  }
});
