// A pretend schema v2 and payload v2, for tests only: proof that a later version can be added.
import { SCHEMAS, type Schema } from '../../src/record/db.ts';
import type { PayloadMigration } from '../../src/record/migrations.ts';

export const TEST_SCHEMAS: readonly Schema[] = [
  ...SCHEMAS,
  { version: 2, stores: { entries: 'id, local_date, month, updated_at' }, upgrade: { entries: row => ({ ...row, month: String(row.local_date).slice(0, 7) }) } },
];

export const TEST_V2: PayloadMigration = {
  id: 'test-notyet-v2', table: 'notyet', slot: 'w', from: 1,
  up: fields => ({ ...fields, text: `${String(fields.text)} (v2)` }),
};
