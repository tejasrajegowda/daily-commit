import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Secret } from '../../src/vault/cipher.ts';
import { enrolMode, forgetDevice, offeredModes, unlockWithDevice } from '../../src/vault/devices.ts';
import type { NewVault } from '../../src/vault/keys.ts';
import { rowCipher } from '../../src/vault/rowCipher.ts';
import { TABLE_TAGS } from '../../src/vault/tags.ts';
import type { VaultRowsIn } from '../../src/vault/vault.ts';
import { GOLDEN_PASSPHRASE, OBSERVATION_ID } from './vectors.ts';
import { fakePlugin, MAX_CODE_TRIES } from './fakePlugin.ts';
import { freshVault, goldenVault, utf8 } from './helpers.ts';

const PASS: Secret = { method: 'passphrase', text: GOLDEN_PASSPHRASE };
const CODE = '24681357';
const OBS = { table: TABLE_TAGS.observations, id: OBSERVATION_ID, slot: 'r' } as const;

const rowsOf = (made: NewVault): VaultRowsIn => ({ vault: made.vault, passphrase: made.wrappers[0], recovery: made.wrappers[1] });

/** Whether keys opened through the phone open what the vault's own keys sealed. */
async function opensSame(made: NewVault, keys: Parameters<typeof rowCipher>[0]): Promise<boolean> {
  const env = await rowCipher(made.keys).seal(OBS, utf8('CANARY-TEST'));
  return new TextDecoder().decode(await rowCipher(keys).open(OBS, env)) === 'CANARY-TEST';
}

test('phone lock: enrolled after the passphrase is typed again, then it opens the vault by itself', async () => {
  const made = await goldenVault();
  const f = fakePlugin();
  assert.deepEqual(await offeredModes(f.plugin), []);
  assert.deepEqual(await enrolMode(rowsOf(made), PASS, f.plugin, 'phone-lock'), { kind: 'Enrolled' });
  assert.deepEqual(await offeredModes(f.plugin), ['phone-lock']);
  const opened = await unlockWithDevice(rowsOf(made), f.plugin, { mode: 'phone-lock' });
  assert.equal(opened.kind, 'Unlocked');
  if (opened.kind === 'Unlocked') assert.ok(await opensSame(made, opened.keys));
});

test('enrolling needs the right passphrase or code; a wrong one enrols nothing', async () => {
  const f = fakePlugin();
  assert.deepEqual(await enrolMode(rowsOf(await goldenVault()), { method: 'passphrase', text: 'CANARY wrong' }, f.plugin, 'phone-lock'), { kind: 'WrongSecret' });
  assert.deepEqual(f.copies.size, 0);
});

test('switching modes: the new copy is made and opened back before the old one is deleted', async () => {
  const made = await goldenVault();
  const f = fakePlugin();
  await enrolMode(rowsOf(made), PASS, f.plugin, 'phone-lock');
  f.log.length = 0;
  assert.deepEqual(await enrolMode(rowsOf(made), PASS, f.plugin, 'own-code', CODE), { kind: 'Enrolled' });
  assert.deepEqual(f.log, ['status', 'enrol own-code', 'verifyCode', 'remove phone-lock']);
  assert.deepEqual(await offeredModes(f.plugin), ['own-code']);
});

test('a new copy that does not open back to the same key is deleted, and the old mode stays', async () => {
  const made = await goldenVault();
  const f = fakePlugin();
  await enrolMode(rowsOf(made), PASS, f.plugin, 'phone-lock');
  f.lieNext('A'.repeat(43));
  assert.deepEqual(await enrolMode(rowsOf(made), PASS, f.plugin, 'own-code', CODE), { kind: 'NotVerified' });
  assert.deepEqual(await offeredModes(f.plugin), ['phone-lock']);
});

test('an own code is at least six digits and only digits', async () => {
  const made = await goldenVault();
  const f = fakePlugin();
  for (const bad of [undefined, '12345', '12345a', ' 123456', '١٢٣٤٥٦']) {
    assert.deepEqual(await enrolMode(rowsOf(made), PASS, f.plugin, 'own-code', bad), { kind: 'CodeTooShort' }, String(bad));
  }
  assert.equal(f.copies.size, 0);
  assert.deepEqual(await enrolMode(rowsOf(made), PASS, f.plugin, 'own-code', '123456'), { kind: 'Enrolled' });
});

test('wrong codes count down; the fifth deletes the code and fingerprint copies, and the passphrase still opens', async () => {
  const made = await goldenVault();
  const f = fakePlugin();
  await enrolMode(rowsOf(made), PASS, f.plugin, 'own-code', CODE);
  await enrolMode(rowsOf(made), PASS, f.plugin, 'fingerprint');
  for (let left = MAX_CODE_TRIES - 1; left > 0; left--) {
    assert.deepEqual(await unlockWithDevice(rowsOf(made), f.plugin, { mode: 'own-code', code: '00000000' }), { kind: 'WrongCode', triesLeft: left });
  }
  assert.deepEqual(await unlockWithDevice(rowsOf(made), f.plugin, { mode: 'own-code', code: '00000000' }), { kind: 'CopyGone', offered: [] });
  assert.deepEqual(await offeredModes(f.plugin), []);
  assert.deepEqual(await enrolMode(rowsOf(made), PASS, f.plugin, 'phone-lock'), { kind: 'Enrolled' });   // the passphrase still works
});

test('a right code resets the count', async () => {
  const made = await goldenVault();
  const f = fakePlugin();
  await enrolMode(rowsOf(made), PASS, f.plugin, 'own-code', CODE);
  await unlockWithDevice(rowsOf(made), f.plugin, { mode: 'own-code', code: '00000000' });
  assert.equal((await unlockWithDevice(rowsOf(made), f.plugin, { mode: 'own-code', code: CODE })).kind, 'Unlocked');
  assert.deepEqual(await unlockWithDevice(rowsOf(made), f.plugin, { mode: 'own-code', code: '00000000' }), { kind: 'WrongCode', triesLeft: MAX_CODE_TRIES - 1 });
});

test('a fingerprint lives inside own-code mode, and an invalidated one falls back to the code', async () => {
  const made = await goldenVault();
  const f = fakePlugin();
  assert.deepEqual(await enrolMode(rowsOf(made), PASS, f.plugin, 'fingerprint'), { kind: 'NeedsOwnCode' });
  await enrolMode(rowsOf(made), PASS, f.plugin, 'own-code', CODE);
  assert.deepEqual(await enrolMode(rowsOf(made), PASS, f.plugin, 'fingerprint'), { kind: 'Enrolled' });
  assert.deepEqual(await offeredModes(f.plugin), ['own-code', 'fingerprint']);
  assert.equal((await unlockWithDevice(rowsOf(made), f.plugin, { mode: 'fingerprint' })).kind, 'Unlocked');
  f.invalidate('fingerprint');
  assert.deepEqual(await unlockWithDevice(rowsOf(made), f.plugin, { mode: 'fingerprint' }), { kind: 'CopyGone', offered: ['own-code'] });
  assert.equal((await unlockWithDevice(rowsOf(made), f.plugin, { mode: 'own-code', code: CODE })).kind, 'Unlocked');
});

test('backing out of the phone\'s prompt changes nothing', async () => {
  const made = await goldenVault();
  const f = fakePlugin();
  await enrolMode(rowsOf(made), PASS, f.plugin, 'phone-lock');
  f.cancelNext();
  assert.deepEqual(await unlockWithDevice(rowsOf(made), f.plugin, { mode: 'phone-lock' }), { kind: 'Cancelled' });
  assert.deepEqual(await offeredModes(f.plugin), ['phone-lock']);
});

test('a phone copy left from another vault never opens this one: every copy is deleted, and the passphrase is asked for', async () => {
  const before = await freshVault();
  const f = fakePlugin();
  await enrolMode(rowsOf(before), { method: 'passphrase', text: 'CANARY other passphrase' }, f.plugin, 'own-code', CODE);
  await enrolMode(rowsOf(before), { method: 'passphrase', text: 'CANARY other passphrase' }, f.plugin, 'fingerprint');
  const restored = await goldenVault();      // another vault's file was restored over it
  assert.deepEqual(await unlockWithDevice(rowsOf(restored), f.plugin, { mode: 'fingerprint' }), { kind: 'CopyGone', offered: [] });
  assert.deepEqual(await offeredModes(f.plugin), []);
});

test('a copy handed back as something other than a 32-byte key counts as gone', async () => {
  const made = await goldenVault();
  const f = fakePlugin();
  await enrolMode(rowsOf(made), PASS, f.plugin, 'phone-lock');
  f.lieNext('not base64url!');
  assert.deepEqual(await unlockWithDevice(rowsOf(made), f.plugin, { mode: 'phone-lock' }), { kind: 'CopyGone', offered: [] });
});

test('forgetting the device deletes every copy', async () => {
  const made = await goldenVault();
  const f = fakePlugin();
  await enrolMode(rowsOf(made), PASS, f.plugin, 'own-code', CODE);
  await enrolMode(rowsOf(made), PASS, f.plugin, 'fingerprint');
  await forgetDevice(f.plugin);
  assert.deepEqual(await offeredModes(f.plugin), []);
});
