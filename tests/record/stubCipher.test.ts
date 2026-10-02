import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TABLE_TAGS } from '../../src/vault/tags.ts';
import type { EnvelopeContext } from '../../src/vault/cipher.ts';
import { jsonBytes, parseJsonBytes } from '../../src/record/bytes.ts';
import { freshDb } from './helpers.ts';
import { stubCipher } from './stubCipher.ts';
import { guarded } from './txGuard.ts';

const ctx: EnvelopeContext = { table: TABLE_TAGS.entries, id: 'e1', slot: 'w' };

test('the stand-in opens what it locked, for the same row and slot only', async () => {
  const c = stubCipher();
  const env = await c.seal(ctx, jsonBytes({ body: 'CANARY-TEST' }));
  assert.deepEqual(parseJsonBytes(await c.open(ctx, env)), { body: 'CANARY-TEST' });
  await assert.rejects(c.open({ ...ctx, id: 'e2' }, env), { failure: 'damaged' });
  await assert.rejects(c.open({ ...ctx, slot: 'r' }, env), { failure: 'other-vault' });
  await assert.rejects(c.open(ctx, { ...env, v: 2 }), { failure: 'newer-app' });
  await assert.rejects(stubCipher({ r: 'x', w: 'y' }).open(ctx, env), { failure: 'other-vault' });
});

test('the stand-in answers late, as WebCrypto does', async () => {
  let done = false;
  void stubCipher().seal(ctx, Uint8Array.of(1)).then(() => { done = true; });
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(done, false);
});

test('the guard refuses a cipher call inside a storage transaction, and allows one outside', async () => {
  const db = freshDb();
  const c = guarded(stubCipher());
  await assert.doesNotReject(c.seal(ctx, Uint8Array.of(1)));
  await assert.rejects(
    db.transaction('rw', db.entries, async () => { await c.seal(ctx, Uint8Array.of(1)); }),
    /inside a storage transaction/,
  );
  db.close();
});
