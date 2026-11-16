import type { BackupCipher, RowCipher } from '../vault/cipher.ts';
import { SYNCED, type RecordDb, type TableName } from './db.ts';
import type { Model } from './model.ts';
import { openModel, type RawTables } from './read.ts';
import { writeQueue } from './queue.ts';
import { locked, quotaFull, saved, type Refusal, type Result } from './results.ts';
import { nextStamp } from './time.ts';
import { uuidv7 } from './ids.ts';
import { changeRows, wipeLines, wipeRows, withLog, type Wipe } from './changes.ts';

// The record's one way in and out. Writes run one at a time; each one prepares and locks its rows
// first, then makes all its changes in one transaction that holds nothing but storage calls, so a
// save is all or nothing. Every write also adds its change-log lines to that same transaction
// (D-25), so no operation can store a change without its line, or a line without its change.

/** The open record: what was decrypted, the cipher that opened it, and this device. */
export interface Session {
  readonly cipher: RowCipher;
  /** locks whole backup files; only export and the snapshot at lock use it */
  readonly backup?: BackupCipher;
  readonly model: Model;
  readonly deviceId: string;
  /** the newest change stamp; never stored, worked out at unlock */
  lastWriteMs: number | undefined;
  /** whether a write was stored since unlock; the snapshot at lock needs it when the clock was set back */
  changed: boolean;
}

/** The stamps every row a write touches will carry. */
export interface Stamp {
  readonly updated_at: number;
  readonly updated_by: string;
}

export interface Put {
  readonly table: TableName;
  readonly row: object;
}

/** What a prepared write will do. */
export interface Plan<T> {
  readonly puts: readonly Put[];
  /** plain facts checked again inside the transaction, such as the seal; storage reads only, never the cipher */
  readonly check?: () => Refusal | undefined | Promise<Refusal | undefined>;
  /** brings memory up to date, once the transaction has committed */
  readonly apply: (model: Model) => void;
  readonly value: T;
}

export interface WriteSpec<T> {
  /** every table the transaction touches */
  readonly tables: readonly TableName[];
  /**
   * A write that only adds usage lines to the log: it isn't a change to the record, so it moves
   * neither `changed` nor the last-write stamp, and opening and locking the app writes no backup.
   */
  readonly quiet?: boolean;
  /** checks, computes and locks everything, outside any transaction; or refuses */
  prepare(session: Session, stamp: Stamp): Promise<Plan<T> | Refusal>;
}

export type CommitOutcome = Refusal | 'committed' | 'quota-full';

export interface RecordCore {
  readonly db: RecordDb;
  readonly now: () => number;
  /** the open record, or undefined while locked */
  readonly session: Session | undefined;
  /** a new row id: a sheet makes it when it opens, so saving twice writes one row */
  newId(): string;
  /** whether first run finished; plain, so it is known before unlock */
  hasVault(): Promise<boolean>;
  /** opens everything into memory, decrypting after the read has finished */
  unlock(cipher: RowCipher, backup?: BackupCipher): Promise<void>;
  /**
   * Drops everything from memory, once any write already started has finished. `beforeDrop` runs
   * first, with the keys still there; the keys drop even if it fails. Resolves to what it returned,
   * or undefined if nothing was open.
   */
  lock<T = void>(beforeDrop?: (session: Session) => Promise<T>): Promise<T | undefined>;
  /** one write, for the operations in record/ */
  write<T>(spec: WriteSpec<T>): Promise<Result<T>>;
  /** runs a job in the write queue; for record/'s own first run and restore */
  serial<T>(job: () => Promise<T>): Promise<T>;
  /**
   * One transaction over the given tables; for record/'s own first run and restore. With `log`, the
   * puts are logged as a write's are, sealed with the cipher passed in (first run has no session).
   */
  commit(tables: readonly TableName[], puts: readonly Put[], check?: Plan<unknown>['check'], log?: CommitLog): Promise<CommitOutcome>;
}

/** What a commit outside a write needs to log its puts. */
export interface CommitLog {
  readonly cipher: RowCipher;
  readonly stamp: Stamp;
}

export interface RecordDeps {
  readonly db: RecordDb;
  /** the clock: tests set it, the app passes Date.now */
  readonly now: () => number;
}

class Refused extends Error {
  readonly refusal: Refusal;
  constructor(refusal: Refusal) {
    super(refusal.kind);
    this.refusal = refusal;
  }
}

export const isQuotaFull = (e: unknown): boolean =>
  e instanceof Error && (e.name === 'QuotaExceededError' || (e as { inner?: { name?: string } }).inner?.name === 'QuotaExceededError');

/**
 * The newest change stamp in storage: one lookup on each table's updated_at index and on the log's
 * `at`, nothing decrypted. The log counts too, so a later stamp is always after every line, and the
 * month files' cursor (lines before it are archived) is never passed by a new line.
 */
export async function newestStamp(db: RecordDb): Promise<number | undefined> {
  let latest: number | undefined;
  for (const table of SYNCED) {
    const row = (await db.table(table).orderBy('updated_at').last()) as { updated_at: number } | undefined;
    if (row && (latest === undefined || row.updated_at > latest)) latest = row.updated_at;
  }
  const line = await db.changes.orderBy('at').last();
  if (line?.at !== undefined && (latest === undefined || line.at > latest)) latest = line.at;
  return latest;
}

export function openRecord(deps: RecordDeps): RecordCore {
  const { db, now } = deps;
  const serial = writeQueue();
  let session: Session | undefined;

  async function commit(tables: readonly TableName[], puts: readonly Put[], check?: Plan<unknown>['check'], log?: CommitLog): Promise<CommitOutcome> {
    let wipes: readonly Wipe[] = [];
    if (log) {
      // the check first (storage only, so safe outside the transaction): a refusal is told as itself, and
      // costs no opening or sealing; it runs again inside the transaction
      const early = await check?.();
      if (early) return early;
      const input = { db, cipher: log.cipher, puts, stamp: log.stamp, newId: () => uuidv7(now()) };
      const lines = await changeRows(input);
      const wiping = await wipeRows(input);
      wipes = wiping.wipes;
      puts = [...puts, ...[...lines, ...wiping.lines].map((row): Put => ({ table: 'changes', row }))];
      tables = withLog(tables);
      // a wipe marks the month files holding the wiped lines, in the cursor on this device
      if (wipes.length > 0 && !tables.includes('device')) tables = [...tables, 'device'];
    }
    try {
      return await db.transaction('rw', tables.map(t => db.table(t)), async () => {
        const refusal = await check?.();
        if (refusal) throw new Refused(refusal);
        // a change line is only ever added: an id that already exists aborts the whole write
        for (const p of puts) await (p.table === 'changes' ? db.table(p.table).add(p.row) : db.table(p.table).put(p.row));
        if (wipes.length > 0) await wipeLines(db, wipes);
        return 'committed' as const;
      });
    } catch (e) {
      if (e instanceof Refused) return e.refusal;
      if (isQuotaFull(e)) return 'quota-full';
      throw e;
    }
  }

  return {
    db,
    now,
    get session() { return session; },
    newId: () => uuidv7(now()),
    hasVault: async () => (await db.vault.count()) > 0,
    unlock: (cipher, backup) => serial(async () => {
      if ((await db.vault.count()) === 0) throw new Error('nothing to unlock: first run has not finished');
      const raw = await db.transaction('r', SYNCED.map(t => db.table(t)), async () =>
        Object.fromEntries(await Promise.all(SYNCED.map(async t => [t, await db.table(t).toArray()] as const))) as unknown as RawTables);
      const device = await db.device.get('device_id');
      const lastWriteMs = await newestStamp(db);
      const model = await openModel(cipher, raw);
      session = { cipher, backup, model, deviceId: String(device?.value ?? ''), lastWriteMs, changed: false };
    }),
    lock: <T>(beforeDrop?: (session: Session) => Promise<T>) => serial(async (): Promise<T | undefined> => {
      const open = session;
      try {
        return open && beforeDrop ? await beforeDrop(open) : undefined;
      } finally {
        session = undefined;
      }
    }),
    write: <T>(spec: WriteSpec<T>) => serial(async (): Promise<Result<T>> => {
      const s = session;
      if (!s) return locked();
      const stamp: Stamp = { updated_at: nextStamp(now(), s.lastWriteMs), updated_by: s.deviceId };
      const plan = await spec.prepare(s, stamp);
      if ('kind' in plan) return plan;
      // a quiet write moves no stamp, so a change to the record in one would never reach a backup
      if (spec.quiet && plan.puts.some(p => p.table !== 'changes')) throw new Error('a quiet write only adds lines to the log');
      if (plan.puts.length === 0) return saved(plan.value);   // nothing to store: nothing changes, not even the last-write stamp
      const outcome = await commit(spec.tables, plan.puts, plan.check, { cipher: s.cipher, stamp });
      if (outcome === 'quota-full') return quotaFull();
      if (outcome !== 'committed') return outcome;
      if (!spec.quiet) {
        s.lastWriteMs = stamp.updated_at;
        s.changed = true;
      }
      plan.apply(s.model);
      return saved(plan.value);
    }),
    serial,
    commit,
  };
}
