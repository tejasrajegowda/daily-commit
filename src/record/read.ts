import type { Envelope, RowCipher } from '../vault/cipher.ts';
import type { Observation } from '../rules/types.ts';
import type { Cue, CueSettings } from '../rules/cues.ts';
import type { SyncedTable } from './db.ts';
import type { HabitRecord, Model } from './model.ts';
import { openParts, plainOf, type Opened, type Plain } from './payload.ts';
import {
  cueForRules, cueFromParts, cueSettingsOf, dayFromParts, entryFromParts, habitFromParts, notYetFromParts,
  observationFromParts, reviewFromParts, settingsFromValues, withRestDays,
} from './mapping.ts';

// The plaintext read side. Rows are opened after their read has finished, and the open record is
// kept in memory only while unlocked. Backup, export and restore never come through here: they copy
// rows exactly as stored.

export type StoredRow = Readonly<Record<string, unknown>>;
export type RawTables = Readonly<Record<SyncedTable, readonly StoredRow[]>>;

interface OpenRow extends Opened {
  readonly plain: Plain;
}

/** Opens every live row of one table; tombstones stay behind. */
async function openAll(cipher: RowCipher, table: SyncedTable, rows: readonly StoredRow[]): Promise<OpenRow[]> {
  return Promise.all(rows.filter(row => row.deleted_at === undefined).map(async row => {
    const plain = plainOf(table, row);
    const slots = { r: row.r as Envelope | undefined, w: row.w as Envelope | undefined };
    return { plain, ...(await openParts(cipher, table, plain, slots)) };
  }));
}

/** Opens everything into the in-memory model. */
export async function openModel(cipher: RowCipher, raw: RawTables): Promise<Model> {
  const open = (table: SyncedTable) => openAll(cipher, table, raw[table]);
  const [settings, habits, observations, days, entries, notyet, cues, reviews] = await Promise.all([
    open('settings'), open('habits'), open('observations'), open('days'), open('entries'), open('notyet'), open('cues'), open('reviews'),
  ]);
  return {
    settings: settingsFromValues(new Map(settings.map(o => [o.plain.key ?? '', (o.r ?? o.w)?.value] as const))),
    habits: new Map(habits.map(o => { const h = habitFromParts(o.plain, o); return [h.id, h] as const; })),
    observations: new Map(observations.map(o => { const x = observationFromParts(o.plain, o); return [`${x.habitId}|${x.date}`, x] as const; })),
    days: new Map(days.map(o => { const d = dayFromParts(o.plain, o); return [d.date, d] as const; })),
    entries: new Map(entries.map(o => { const e = entryFromParts(o.plain, o); return [e.id, e] as const; })),
    notyet: new Map(notyet.map(o => { const n = notYetFromParts(o.plain, o); return [n.id, n] as const; })),
    cues: new Map(cues.map(o => { const c = cueFromParts(o.plain, o); return [c.id, c] as const; })),
    reviews: new Map(reviews.map(o => { const v = reviewFromParts(o.plain, o); return [v.key, v] as const; })),
  };
}

/** What the rules need from the open record, in their own shapes. */
export interface RulesInput {
  readonly habits: readonly HabitRecord[];
  readonly index: ReadonlyMap<string, Observation>;
  readonly cues: readonly Cue[];
  readonly cueSettings: CueSettings;
}

export function rulesInput(model: Model): RulesInput {
  const habits = [...model.habits.values()];
  const restDays = [...model.days.values()].filter(d => d.restDay).map(d => d.date);
  return {
    habits,
    index: withRestDays(model.observations.values(), restDays, habits.map(h => h.id)),
    cues: [...model.cues.values()].map(cueForRules),
    cueSettings: cueSettingsOf(model.settings),
  };
}
