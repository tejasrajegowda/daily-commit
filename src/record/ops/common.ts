import type { LocalDate } from '../../rules/types.ts';
import type { LockedTable } from '../../vault/tags.ts';
import type { RowCipher } from '../../vault/cipher.ts';
import type { RecordCore, Session, Stamp } from '../core.ts';
import { sealParts, type Parts } from '../payload.ts';
import { sealed, type Refusal } from '../results.ts';
import { isOpen, type WriteKind } from '../seal.ts';
import { beforeBoundary, judged, openSheet, type DayRule, type Sheet } from '../time.ts';

// What every operation shares: the day rule, the moment a save is judged at, how a row is stored or
// turned into a tombstone, and the seal checked again inside the transaction.

export function dayRule(s: Session): DayRule {
  return { tz: s.model.settings.tz, boundary: s.model.settings.boundary };
}

/** Opens a sheet now. A screen calls it when a sheet opens, and passes the result with every save from it. */
export function sheetNow(core: RecordCore): Sheet {
  const s = core.session;
  if (!s) throw new Error('the record is locked');
  return openSheet(core.now(), s.lastWriteMs, dayRule(s));
}

/** The moment and the day a save is judged by, now. */
export function judgedNow(core: RecordCore, s: Session, sheet: Sheet | undefined): { readonly at: number; readonly today: LocalDate } {
  return judged(sheet, core.now(), s.lastWriteMs, dayRule(s));
}

/** A record's row as it will be stored: plain fields, stamps, and its locked slots. */
export async function storedRow(cipher: RowCipher, table: LockedTable, parts: Parts, stamp: Stamp): Promise<object> {
  return { ...parts.plain, ...stamp, ...(await sealParts(cipher, table, parts)) };
}

/** A tombstone: the key and other plain fields, the stamps, and when it went; nothing locked. */
export function tombstone(parts: Parts, stamp: Stamp): object {
  return { ...parts.plain, ...stamp, deleted_at: stamp.updated_at };
}

/**
 * The seal on one date, as a check a write runs in prepare and again inside its transaction.
 * `morning` says the habit is asked in the morning that day, for the one value allowed ahead.
 */
export function sealCheck(core: RecordCore, s: Session, date: LocalDate, kind: WriteKind, sheet: Sheet | undefined, morning = false): () => Refusal | undefined {
  return () => {
    const { at, today } = judgedNow(core, s, sheet);
    return isOpen(date, kind, today, morning && beforeBoundary(at, dayRule(s))) ? undefined : sealed();
  };
}
