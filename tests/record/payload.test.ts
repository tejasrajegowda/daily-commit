import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TABLE_TAGS, type LockedTable } from '../../src/vault/tags.ts';
import { jsonBytes } from '../../src/record/bytes.ts';
import { KEY_FIELDS, LOCKED, OTHER_PLAIN, PAYLOAD_VERSION, STAMP_FIELDS, openParts, plainOf, rowId, sealParts } from '../../src/record/payload.ts';
import { stubCipher } from './stubCipher.ts';
import { guarded } from './txGuard.ts';

const cipher = guarded(stubCipher());

test('every locked table has key fields and a locked list, and no field is both plain and locked', () => {
  assert.deepEqual(Object.keys(KEY_FIELDS).sort(), Object.keys(TABLE_TAGS).sort());
  for (const t of Object.keys(TABLE_TAGS) as LockedTable[]) {
    const plain = new Set<string>([...KEY_FIELDS[t], ...OTHER_PLAIN[t], ...STAMP_FIELDS]);
    for (const f of [...LOCKED[t].r, ...LOCKED[t].w]) assert.ok(!plain.has(f), `${t}.${f} is both`);
  }
});

test('a row\'s locked fields go through the cipher and come back, with the payload version inside', async () => {
  const parts = { plain: { id: 'e1', local_date: '2026-01-05' }, w: { body: 'CANARY-TEST', trashed_at: undefined } };
  const slots = await sealParts(cipher, 'entries', parts);
  assert.deepEqual(Object.keys(slots), ['w']);
  assert.deepEqual(await openParts(cipher, 'entries', parts.plain, slots), { w: { body: 'CANARY-TEST', pv: PAYLOAD_VERSION } });
});

test('an observation is bound to its habit and its date together', async () => {
  const plain = { habit_id: 'h1', local_date: '2026-01-05' };
  assert.equal(rowId('observations', plain), 'h1|2026-01-05');
  const slots = await sealParts(cipher, 'observations', { plain, r: { kind: 'tri', value: 'did' } });
  await assert.rejects(openParts(cipher, 'observations', { habit_id: 'h1', local_date: '2026-01-06' }, slots), { failure: 'damaged' });
});

test('a value from a newer app refuses to open, and a row without its key is refused', async () => {
  const env = await cipher.seal({ table: TABLE_TAGS.habits, id: 'h1', slot: 'r' }, jsonBytes({ name: 'x', pv: PAYLOAD_VERSION + 1 }));
  await assert.rejects(openParts(cipher, 'habits', { id: 'h1' }, { r: env }), { failure: 'newer-app' });
  assert.throws(() => rowId('habits', {}), /no id/);
});

test('plainOf keeps only a row\'s plain fields, as text', () => {
  const row = { key: 'w:2026-01-05', period_start: '2026-01-05', period_end: '2026-01-11', updated_at: 5, updated_by: 'dev', w: {} };
  assert.deepEqual(plainOf('reviews', row), { key: 'w:2026-01-05', period_start: '2026-01-05', period_end: '2026-01-11' });
});
