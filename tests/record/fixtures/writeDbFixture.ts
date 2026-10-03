// Writes db-v1.fixture.json: every row of a schema v1 database holding the invented record. Run
// once, by hand: node tests/record/fixtures/writeDbFixture.ts. It refuses to replace the file.
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { filledRecord } from '../helpers.ts';

const path = join(import.meta.dirname, 'db-v1.fixture.json');
if (existsSync(path)) throw new Error('db-v1.fixture.json exists; a version\'s fixture is never written again');
const { db } = await filledRecord();
const tables = Object.fromEntries(await Promise.all(db.tables.map(async t => [t.name, await t.toArray()] as const)));
writeFileSync(path, `${JSON.stringify({ schema_version: 1, tables }, null, 1)}\n`);
console.log('wrote', Object.fromEntries(Object.entries(tables).map(([name, rows]) => [name, rows.length])));
