import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { WrapperRow } from '../../src/record/rows.ts';
import { jsonBytes, parseJsonBytes, toBase64url } from '../../src/record/bytes.ts';
import { FORMAT, frame, headerBytes, readFrame, type BackupHeader } from '../../src/record/backup/format.ts';
import { BODY_TABLES, bodyJson, gunzip, gzip, parseBody, type StoredRows } from '../../src/record/backup/body.ts';
import { VAULT, WRAPPERS } from './fixtures.ts';

const [passphrase, recovery] = WRAPPERS as readonly [WrapperRow, WrapperRow];
const IV = new Uint8Array(12).fill(7);
const HEADER: BackupHeader = {
  format: FORMAT, format_version: 1, schema_version: 1, app_version: '0.1.0', exported_at: Date.UTC(2026, 0, 5, 9),
  vault_id: VAULT.vault_id, kid: VAULT.kid, generation: 1, iv: toBase64url(IV), wrappers: { passphrase, recovery },
};
const CT = new Uint8Array(16).fill(1);

test('the header is JSON with its keys in the fixed order, however it was built', () => {
  const { wrappers, iv, ...rest } = HEADER;
  const bytes = headerBytes({ wrappers, iv, ...rest });
  assert.deepEqual(bytes, headerBytes(HEADER));
  assert.ok(new TextDecoder().decode(bytes).startsWith('{"format":"daily-commit-backup","format_version":1,"schema_version":1,"app_version":"0.1.0","exported_at":'));
  assert.deepEqual(Object.keys(parseJsonBytes(bytes) as object), ['format', 'format_version', 'schema_version', 'app_version', 'exported_at', 'vault_id', 'kid', 'generation', 'iv', 'wrappers']);
});

test('a file is DCBK, the header length big-endian, the header, then the body; reading it gives every part back', () => {
  const head = headerBytes(HEADER);
  const file = frame(head, CT);
  assert.deepEqual(file.subarray(0, 4), Uint8Array.of(0x44, 0x43, 0x42, 0x4b));
  assert.equal(new DataView(file.buffer).getUint32(4), head.length);
  assert.equal(file.length, 8 + head.length + CT.length);
  const read = readFrame(file);
  assert.deepEqual(read.header, HEADER);
  assert.deepEqual(read.headerBytes, head);
  assert.deepEqual(read.iv, IV);
  assert.deepEqual(read.ct, CT);
});

test('a file cut short, with a bad frame, or with a header that is not one, is damaged', () => {
  const good = frame(headerBytes(HEADER), CT);
  const withHeader = (h: unknown) => frame(jsonBytes(h), CT);
  const tooLong = good.slice();
  new DataView(tooLong.buffer).setUint32(4, tooLong.length);
  const cases: [string, Uint8Array][] = [
    ['an empty file', new Uint8Array(0)],
    ['not DCBK', Uint8Array.from(good, (b, i) => (i === 0 ? 0x58 : b))],
    ['cut inside the tag', good.slice(0, good.length - 1)],
    ['a header length beyond the file', tooLong],
    ['a header that is not JSON', frame(Uint8Array.of(0x7b, 0x7b), CT)],
    ['a header that is not an object', withHeader([1, 2])],
    ['another format', withHeader({ ...HEADER, format: 'something-else' })],
    ['no wrappers', withHeader({ ...HEADER, wrappers: {} })],
    ['an IV that is not 12 bytes', withHeader({ ...HEADER, iv: 'AAAA' })],
  ];
  for (const [what, bytes] of cases) assert.throws(() => readFrame(bytes), { reason: 'damaged' }, what);
});

test('a later format or a later schema needs a newer app', () => {
  for (const later of [{ format_version: 2 }, { schema_version: 2 }]) {
    assert.throws(() => readFrame(frame(jsonBytes({ ...HEADER, ...later }), CT)), { reason: 'newer-app' }, JSON.stringify(later));
  }
});

test('the body lists its tables in the fixed order and survives gzip; anything else is damaged', async () => {
  const tables = Object.fromEntries([...BODY_TABLES].reverse().map(t => [t, t === 'habits' ? [{ id: 'h-1', updated_at: 1, updated_by: 'd' }] : []])) as unknown as StoredRows;
  const bytes = bodyJson(tables);
  assert.deepEqual(Object.keys(parseBody(bytes)), [...BODY_TABLES]);
  assert.deepEqual(await gunzip(await gzip(bytes)), bytes);
  await assert.rejects(gunzip(Uint8Array.of(1, 2, 3)), { reason: 'damaged' });
  assert.throws(() => parseBody(jsonBytes({ tables: { habits: [] } })), { reason: 'damaged' });
  assert.throws(() => parseBody(Uint8Array.of(0xff)), { reason: 'damaged' });
});
