import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Secret } from '../../src/vault/cipher.ts';
import { enrolMode, forgetDevice, offeredModes, unlockWithDevice } from '../../src/vault/devices.ts';
import type { NewVault } from '../../src/vault/keys.ts';
import type { VaultPlugin } from '../../src/vault/plugin.ts';
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

test('a phone copy left from another vault never opens this one: each such copy is deleted as it is tried, and the passphrase is asked for', async () => {
  const before = await freshVault();
  const f = fakePlugin();
  await enrolMode(rowsOf(before), { method: 'passphrase', text: 'CANARY other passphrase' }, f.plugin, 'own-code', CODE);
  await enrolMode(rowsOf(before), { method: 'passphrase', text: 'CANARY other passphrase' }, f.plugin, 'fingerprint');
  const restored = await goldenVault();      // another vault's file was restored over it
  assert.deepEqual(await unlockWithDevice(rowsOf(restored), f.plugin, { mode: 'fingerprint' }), { kind: 'CopyGone', offered: ['own-code'] });
  assert.deepEqual(await unlockWithDevice(rowsOf(restored), f.plugin, { mode: 'own-code', code: CODE }), { kind: 'CopyGone', offered: [] });
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

// ── Review R3: copies of more than one vault on the phone, a phone that refuses, and a restart.

const OTHER: Secret = { method: 'passphrase', text: 'CANARY other passphrase' };

test('R3-1: a code change whose new copy comes back unreadable fails cleanly: no error escapes and the new code is not left on', async () => {
  const made = await goldenVault();
  const f = fakePlugin();
  assert.equal((await enrolMode(rowsOf(made), PASS, f.plugin, 'own-code', CODE)).kind, 'Enrolled');
  f.lieNext('not base64url!');
  assert.deepEqual(await enrolMode(rowsOf(made), PASS, f.plugin, 'own-code', '13572468'), { kind: 'NotVerified' });
  assert.deepEqual(await offeredModes(f.plugin), []);                   // the phone keeps one copy per mode: the code is off
  assert.equal((await enrolMode(rowsOf(made), PASS, f.plugin, 'own-code', CODE)).kind, 'Enrolled');   // and can be set up again
});

test('R3-2: a copy from another vault removes only itself, so a code enrolled on this vault since is never deleted with it', async () => {
  const before = await freshVault();
  const f = fakePlugin();
  await enrolMode(rowsOf(before), OTHER, f.plugin, 'own-code', CODE);
  await enrolMode(rowsOf(before), OTHER, f.plugin, 'fingerprint');
  const restored = await goldenVault();                                // a restore whose forgetting was interrupted
  assert.equal((await enrolMode(rowsOf(restored), PASS, f.plugin, 'own-code', '13572468')).kind, 'Enrolled');
  assert.deepEqual(await unlockWithDevice(rowsOf(restored), f.plugin, { mode: 'fingerprint' }), { kind: 'CopyGone', offered: ['own-code'] });
  const opened = await unlockWithDevice(rowsOf(restored), f.plugin, { mode: 'own-code', code: '13572468' });
  assert.equal(opened.kind, 'Unlocked');
});

test('R3-3: the wrong-code count survives the app being closed: four misses, a restart, one more, and the copies are gone', async () => {
  const made = await goldenVault();
  const f = fakePlugin();
  await enrolMode(rowsOf(made), PASS, f.plugin, 'own-code', CODE);
  await enrolMode(rowsOf(made), PASS, f.plugin, 'fingerprint');
  for (let i = 0; i < MAX_CODE_TRIES - 1; i++) await unlockWithDevice(rowsOf(made), f.plugin, { mode: 'own-code', code: '00000000' });
  const after = f.restart();                                           // the process died; only what was saved remains
  assert.deepEqual(await unlockWithDevice(rowsOf(made), after, { mode: 'own-code', code: '00000000' }), { kind: 'CopyGone', offered: [] });
  assert.deepEqual(await offeredModes(after), []);
});

test('R3-4: the fifth wrong code deletes the fingerprint copy too, even if the phone kept it', async () => {
  const made = await goldenVault();
  const f = fakePlugin();
  await enrolMode(rowsOf(made), PASS, f.plugin, 'own-code', CODE);
  await enrolMode(rowsOf(made), PASS, f.plugin, 'fingerprint');
  const kept = f.copies.get('fingerprint');
  if (kept === undefined) throw new Error('no fingerprint copy');
  const plugin: VaultPlugin = {
    ...f.plugin,
    verifyCode: async typed => {
      const back = await f.plugin.verifyCode(typed);
      if (back.kind === 'WrongCode' && back.triesLeft === 0) f.copies.set('fingerprint', kept);   // a phone that only dropped the code
      return back;
    },
  };
  for (let i = 0; i < MAX_CODE_TRIES - 1; i++) await unlockWithDevice(rowsOf(made), plugin, { mode: 'own-code', code: '00000000' });
  assert.deepEqual(await unlockWithDevice(rowsOf(made), plugin, { mode: 'own-code', code: '00000000' }), { kind: 'CopyGone', offered: [] });
  assert.equal((await unlockWithDevice(rowsOf(made), plugin, { mode: 'fingerprint' })).kind, 'CopyGone');
});

test('R3-5: a phone that refuses to delete a copy from another vault still gets "use the passphrase", never an error', async () => {
  const before = await freshVault();
  const f = fakePlugin();
  await enrolMode(rowsOf(before), OTHER, f.plugin, 'own-code', CODE);
  await enrolMode(rowsOf(before), OTHER, f.plugin, 'fingerprint');
  const plugin: VaultPlugin = { ...f.plugin, remove: async mode => { if (mode === 'fingerprint') throw new Error('the phone refused'); return f.plugin.remove(mode); } };
  const restored = await goldenVault();
  assert.deepEqual(await unlockWithDevice(rowsOf(restored), plugin, { mode: 'fingerprint' }), { kind: 'CopyGone', offered: ['own-code'] });
});

// ── U5 (Ruling 8): the phone keeps a mode's copy until the new one opens back.

test('U5: a new copy is offered only once it has opened back', async () => {
  const made = await goldenVault();
  const f = fakePlugin();
  await enrolMode(rowsOf(made), PASS, f.plugin, 'own-code', CODE);
  await f.plugin.enrol('fingerprint', 'A'.repeat(43));
  assert.deepEqual(await offeredModes(f.plugin), ['own-code']);          // waiting, not offered
  assert.deepEqual(f.waiting(), ['fingerprint']);
});

test('U5: a code change the phone can\'t confirm keeps the old code, and the fingerprint with it', async () => {
  const made = await goldenVault();
  const f = fakePlugin();
  await enrolMode(rowsOf(made), PASS, f.plugin, 'own-code', CODE);
  await enrolMode(rowsOf(made), PASS, f.plugin, 'fingerprint');
  f.missNext();
  assert.deepEqual(await enrolMode(rowsOf(made), PASS, f.plugin, 'own-code', '13572468'), { kind: 'NotVerified' });
  assert.deepEqual(await offeredModes(f.plugin), ['own-code', 'fingerprint']);
  assert.equal((await unlockWithDevice(rowsOf(made), f.plugin, { mode: 'own-code', code: CODE })).kind, 'Unlocked');
  assert.equal((await unlockWithDevice(rowsOf(made), f.plugin, { mode: 'fingerprint' })).kind, 'Unlocked');
  assert.equal((await unlockWithDevice(rowsOf(made), f.plugin, { mode: 'own-code', code: '13572468' })).kind, 'WrongCode');
});

test('U5: setting the phone\'s lock up again and backing out of the second prompt leaves it as it was', async () => {
  const made = await goldenVault();
  const f = fakePlugin();
  await enrolMode(rowsOf(made), PASS, f.plugin, 'phone-lock');
  f.cancelNext();
  assert.deepEqual(await enrolMode(rowsOf(made), PASS, f.plugin, 'phone-lock'), { kind: 'NotVerified' });
  assert.deepEqual(await offeredModes(f.plugin), ['phone-lock']);
  assert.equal((await unlockWithDevice(rowsOf(made), f.plugin, { mode: 'phone-lock' })).kind, 'Unlocked');
});

test('U4 follow-up: a code whose copy opens to some other key is removed, and the fingerprint with it', async () => {
  const made = await goldenVault();
  const f = fakePlugin();
  await enrolMode(rowsOf(made), PASS, f.plugin, 'own-code', CODE);
  await enrolMode(rowsOf(made), PASS, f.plugin, 'fingerprint');
  f.lieNext('A'.repeat(43));
  assert.deepEqual(await enrolMode(rowsOf(made), PASS, f.plugin, 'own-code', '13572468'), { kind: 'NotVerified' });
  assert.deepEqual(await offeredModes(f.plugin), []);                    // no fingerprint left without its code
});

test('U5: the app ending between the new copy and its check keeps the old copy', async () => {
  const made = await goldenVault();
  const f = fakePlugin();
  await enrolMode(rowsOf(made), PASS, f.plugin, 'own-code', CODE);
  await f.plugin.enrol('own-code', 'A'.repeat(43), '13572468');           // made, never opened back
  const after = f.restart();
  assert.deepEqual(await offeredModes(after), ['own-code']);
  assert.equal((await unlockWithDevice(rowsOf(made), after, { mode: 'own-code', code: CODE })).kind, 'Unlocked');
});
