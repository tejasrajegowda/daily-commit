import { test } from 'node:test';
import assert from 'node:assert/strict';
import { finishFirstRun, firstSettings, prepareVault, sameRecoveryCode, type Prepared } from '../../src/app/firstRunFlow.ts';
import { emptyApp } from './deps.ts';

const PASSPHRASE = 'CANARY river stone lamp';
const SETTINGS = firstSettings(Date.UTC(2026, 0, 5, 9), 'UTC');

async function prepared(app: ReturnType<typeof emptyApp>): Promise<Prepared> {
  const p = await prepareVault(app.deps, PASSPHRASE);
  if (p.kind !== 'Prepared') throw new Error(p.kind);
  return p.prepared;
}

test('a passphrase under 15 characters is refused before anything is stretched or written', async () => {
  const app = emptyApp();
  assert.deepEqual(await prepareVault(app.deps, 'short one'), { kind: 'TooShort' });
  assert.deepEqual(await prepareVault(app.deps, '   fourteen chars  '.slice(0, 17)), { kind: 'TooShort' });
  assert.equal(await app.db.vault.count(), 0);
});

test('the first settings: this timezone, the 04:00 boundary, and today as day 1', () => {
  assert.deepEqual(firstSettings(Date.UTC(2026, 0, 5, 2), 'UTC'), { tz: 'UTC', boundary: 240, journeyStart: '2026-01-04', wakePlan: 420, lightsOutPlan: 1380, cuesOn: true });
});

test('prepare, then finish with the code typed back: the vault is written, the record opens, and after a lock the passphrase opens it again', async () => {
  const app = emptyApp({ deviceModes: false });
  const p = await prepared(app);
  assert.equal(await app.db.vault.count(), 0);                    // nothing written before the type-back
  assert.equal((await finishFirstRun(app.deps, p, p.code, SETTINGS)).kind, 'Saved');
  assert.equal(app.deps.machine.state.kind, 'Open');
  assert.equal(app.core.session?.model.settings.journeyStart, '2026-01-05');
  await app.deps.machine.leave();
  await app.deps.machine.resume();
  assert.equal((await app.deps.lock.unlock({ method: 'passphrase', text: PASSPHRASE })).kind, 'Open');
});

test('a typed-back code that does not match writes nothing, and the same code can still be typed again', async () => {
  const app = emptyApp();
  const p = await prepared(app);
  const wrong = p.code.replace(/^./, c => (c === 'A' ? 'B' : 'A'));
  assert.deepEqual(await finishFirstRun(app.deps, p, wrong, SETTINGS), { kind: 'CodeMismatch' });
  assert.equal(await app.db.vault.count(), 0);
  assert.equal((await finishFirstRun(app.deps, p, p.code, SETTINGS)).kind, 'Saved');
});

test('the code typed back in lower case, with dashes instead of spaces, still matches', () => {
  const code = 'K7M2Q X4TR9 H3WZ8 P6ND2 BV5G7 M8JC4 T2YQ6 R9FE3 4';
  assert.equal(sameRecoveryCode(code, code), sameRecoveryCode(code, code.toLowerCase().replaceAll(' ', '-')));
});

test('with device modes the phone lock is made after the first write; without them nothing is made', async () => {
  const withPhone = emptyApp({ deviceModes: true });
  const p = await prepared(withPhone);
  await finishFirstRun(withPhone.deps, p, p.code, SETTINGS);
  assert.deepEqual([...withPhone.phone.copies.keys()], ['phone-lock']);
  const without = emptyApp({ deviceModes: false });
  const q = await prepared(without);
  await finishFirstRun(without.deps, q, q.code, SETTINGS);
  assert.equal(without.phone.copies.size, 0);
});

test('a phone that cannot make the copy still leaves first run done and the record open', async () => {
  const app = emptyApp({ deviceModes: true });
  app.phone.plugin.enrol = () => Promise.reject(new Error('the phone refused'));
  const p = await prepared(app);
  assert.equal((await finishFirstRun(app.deps, p, p.code, SETTINGS)).kind, 'Saved');
  assert.equal(app.deps.machine.state.kind, 'Open');
});

test('what the screen holds carries no key: only the code to show', async () => {
  const app = emptyApp();
  const p = await prepared(app);
  assert.deepEqual(Object.keys(p), ['code']);
  assert.ok(Object.isFrozen(p));
});
