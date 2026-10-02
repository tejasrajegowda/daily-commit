import type { RecordCore } from '../core.ts';
import type { EntryRecord, Model, NotYetRecord } from '../model.ts';
import { defined, entryToParts, notYetToParts } from '../mapping.ts';
import type { Parts } from '../payload.ts';
import { invalid, type Result } from '../results.ts';
import type { Sheet } from '../time.ts';
import { judgedNow, storedRow, tombstone } from './common.ts';

// Diary pages and Not yet items: words only, locked under the words key. Deleting puts them in a
// trash for 7 days, with undo. After that the words are wiped and only a tombstone is left.

export const TRASH_MS = 7 * 86_400_000;

interface Trashable {
  readonly id: string;
  readonly trashedAt?: number;
}

interface Kind<T extends Trashable> {
  readonly table: 'entries' | 'notyet';
  readonly items: (m: Model) => Map<string, T>;
  readonly toParts: (x: T) => Parts;
}

const ENTRIES: Kind<EntryRecord> = { table: 'entries', items: m => m.entries, toParts: entryToParts };
const NOT_YET: Kind<NotYetRecord> = { table: 'notyet', items: m => m.notyet, toParts: notYetToParts };

/** Saves an item, unless it is in the trash: it has to be put back first. */
function saveItem<T extends Trashable>(core: RecordCore, kind: Kind<T>, make: (existing: T | undefined, sheetToday: string) => T, sheet: Sheet | undefined, id: string): Promise<Result<void>> {
  return core.write({
    tables: [kind.table],
    async prepare(s, stamp) {
      const existing = kind.items(s.model).get(id);
      if (existing?.trashedAt !== undefined) return invalid('in the trash');
      const item = make(existing, judgedNow(core, s, sheet).today);
      return {
        puts: [{ table: kind.table, row: await storedRow(s.cipher, kind.table, kind.toParts(item), stamp) }],
        apply: m => { kind.items(m).set(id, item); },
        value: undefined,
      };
    },
  });
}

function moveTrash<T extends Trashable>(core: RecordCore, kind: Kind<T>, id: string, toTrash: boolean): Promise<Result<void>> {
  return core.write({
    tables: [kind.table],
    async prepare(s, stamp) {
      const item = kind.items(s.model).get(id);
      if (!item) return invalid('no such item');
      if ((item.trashedAt !== undefined) === toTrash) return invalid(toTrash ? 'already in the trash' : 'not in the trash');
      const next: T = defined({ ...item, trashedAt: toTrash ? stamp.updated_at : undefined });
      return {
        puts: [{ table: kind.table, row: await storedRow(s.cipher, kind.table, kind.toParts(next), stamp) }],
        apply: m => { kind.items(m).set(id, next); },
        value: undefined,
      };
    },
  });
}

export function saveEntry(core: RecordCore, input: { readonly id: string; readonly body: string; readonly sheet?: Sheet }): Promise<Result<void>> {
  // a page keeps the day it was first written on
  return saveItem(core, ENTRIES, (existing, today) => ({ id: input.id, date: existing?.date ?? today, body: input.body }), input.sheet, input.id);
}
export const trashEntry = (core: RecordCore, input: { readonly id: string }) => moveTrash(core, ENTRIES, input.id, true);
export const restoreEntry = (core: RecordCore, input: { readonly id: string }) => moveTrash(core, ENTRIES, input.id, false);

export function saveNotYet(core: RecordCore, input: { readonly id: string; readonly text: string; readonly why?: string; readonly startedAt?: number }): Promise<Result<void>> {
  return saveItem(core, NOT_YET, () => defined({ id: input.id, text: input.text, why: input.why, startedAt: input.startedAt }), undefined, input.id);
}
export const trashNotYet = (core: RecordCore, input: { readonly id: string }) => moveTrash(core, NOT_YET, input.id, true);
export const restoreNotYet = (core: RecordCore, input: { readonly id: string }) => moveTrash(core, NOT_YET, input.id, false);

/** Wipes the words of everything that has been in the trash for 7 days: each becomes a tombstone. */
export function sweepTrash(core: RecordCore): Promise<Result<number>> {
  return core.write({
    tables: ['entries', 'notyet'],
    async prepare(s, stamp) {
      const now = core.now();
      const due = <T extends Trashable>(items: Map<string, T>) =>
        [...items.values()].filter(x => x.trashedAt !== undefined && now - x.trashedAt >= TRASH_MS);
      const entries = due(s.model.entries), items = due(s.model.notyet);
      return {
        puts: [
          ...entries.map(e => ({ table: 'entries' as const, row: tombstone(entryToParts(e), stamp) })),
          ...items.map(n => ({ table: 'notyet' as const, row: tombstone(notYetToParts(n), stamp) })),
        ],
        apply: m => {
          for (const e of entries) m.entries.delete(e.id);
          for (const n of items) m.notyet.delete(n.id);
        },
        value: entries.length + items.length,
      };
    },
  });
}
