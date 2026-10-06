import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DIARY_WORDS, dayLabel, freshStill, inTrash, pages, writtenAt } from '../../src/diary/diaryView.ts';
import { uuidv7 } from '../../src/record/ids.ts';
import type { Model } from '../../src/record/model.ts';

const model = (entries: { id: string; date: string; body: string; trashedAt?: number }[]) =>
  ({ entries: new Map(entries.map(e => [e.id, e])) }) as unknown as Model;

test('pages are newest first and leave out the trash; the trash says when each goes, seven days on', () => {
  const m = model([{ id: 'a', date: '2026-01-05', body: 'CANARY a' }, { id: 'b', date: '2026-01-07', body: 'CANARY b' }, { id: 'c', date: '2026-01-06', body: 'CANARY c', trashedAt: 1000 }]);
  assert.deepEqual(pages(m).map(e => e.id), ['b', 'a']);
  assert.deepEqual(inTrash(m.entries.values()).map(t => [t.item.id, t.goneAt]), [['c', 1000 + 7 * 86_400_000]]);
});

test('the time a page was started is read from its id; an id from elsewhere has none', () => {
  const at = Date.UTC(2026, 0, 5, 22, 14);
  assert.equal(writtenAt(uuidv7(at)), at);
  assert.equal(writtenAt('harness-page-4'), undefined);
});

test('days are named the way the index says them', () => {
  assert.equal(dayLabel('2026-01-21', '2026-01-21'), 'Today');
  assert.equal(dayLabel('2026-01-20', '2026-01-21'), 'Yesterday');
  assert.equal(dayLabel('2026-01-19', '2026-01-21'), 'Monday 19');
});

test("a new page's id serves today's new page until that page is written", () => {
  const fresh = { id: 'new', made: '2026-01-21' };
  assert.equal(freshStill(model([]), fresh, '2026-01-21'), true);
  assert.equal(freshStill(model([{ id: 'new', date: '2026-01-21', body: 'CANARY page' }]), fresh, '2026-01-21'), true);
});

test("once today's page is in the trash, a new page gets a new id, never the trashed page's", () => {
  const m = model([{ id: 'new', date: '2026-01-21', body: 'CANARY page', trashedAt: 1000 }]);
  assert.equal(freshStill(m, { id: 'new', made: '2026-01-21' }, '2026-01-21'), false);
});

test("once the day moves on, a new page gets a new id, never the day before's page", () => {
  const m = model([{ id: 'new', date: '2026-01-21', body: 'CANARY night page' }]);
  assert.equal(freshStill(m, { id: 'new', made: '2026-01-21' }, '2026-01-22'), false);
  assert.equal(freshStill(model([]), { id: 'new', made: '2026-01-21' }, '2026-01-22'), false);
});

test("the diary's words have no exclamation mark or percentage", () => {
  for (const w of Object.values(DIARY_WORDS)) assert.doesNotMatch(w, /[!%]/);
});
