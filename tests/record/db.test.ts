import { test } from 'node:test';
import assert from 'node:assert/strict';
import { IDBDatabase } from 'fake-indexeddb';
import { freshDb } from './helpers.ts';

test('schema v1 has exactly the tables, keys and indexes of the plan', async () => {
  const db = freshDb();
  await db.open();
  const shape = Object.fromEntries(db.tables.map(t => [t.name, [t.schema.primKey.keyPath, t.schema.indexes.map(i => i.name).sort()]]));
  assert.deepEqual(shape, {
    wrappers: ['method', []],
    vault: ['key', []],
    settings: ['key', ['updated_at']],
    device: ['key', []],
    habits: ['id', ['updated_at']],
    observations: [['habit_id', 'local_date'], ['habit_id', 'local_date', 'updated_at']],
    days: ['local_date', ['updated_at']],
    entries: ['id', ['local_date', 'updated_at']],
    notyet: ['id', ['updated_at']],
    cues: ['id', ['updated_at']],
    reviews: ['key', ['period_start', 'updated_at']],
    migrations: ['id', []],
  });
  db.close();
});

test('every write transaction waits for the disk', async () => {
  const seen: [unknown, unknown][] = [];
  const original = IDBDatabase.prototype.transaction;
  IDBDatabase.prototype.transaction = function (this: IDBDatabase, ...args: Parameters<typeof original>) {
    seen.push([args[1], args[2]]);
    return original.apply(this, args);
  };
  try {
    const db = freshDb();
    await db.habits.put({ id: 'a', updated_at: 1, updated_by: 'dev' });
    await db.transaction('rw', db.habits, db.days, async () => {
      await db.days.put({ local_date: '2026-01-05', updated_at: 1, updated_by: 'dev' });
    });
    const writes = seen.filter(([mode]) => mode === 'readwrite');
    assert.equal(writes.length, 2);
    for (const [, options] of writes) assert.deepEqual(options, { durability: 'strict' });
    db.close();
  } finally {
    IDBDatabase.prototype.transaction = original;
  }
});

test('an index query also returns rows whose optional fields are empty', async () => {
  const db = freshDb();
  await db.habits.bulkPut([
    { id: 'a', updated_at: 1, updated_by: 'dev' },                                        // nothing locked yet
    { id: 'b', updated_at: 2, updated_by: 'dev', deleted_at: 2 },                          // a tombstone
    { id: 'c', updated_at: 3, updated_by: 'dev', r: { v: 1, k: 'k', iv: 'i', ct: 'c' } },
  ]);
  assert.deepEqual((await db.habits.where('updated_at').aboveOrEqual(0).toArray()).map(r => r.id), ['a', 'b', 'c']);
  db.close();
});
