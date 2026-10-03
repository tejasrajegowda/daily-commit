import type { BackupCipher, RowCipher } from '../vault/cipher.ts';
import { SYNCED, type RecordDb, type TableName } from './db.ts';
import type { Model } from './model.ts';
import { openModel, type RawTables } from './read.ts';
import { writeQueue } from './queue.ts';
import { locked, quotaFull, saved, type Refusal, type Result } from './results.ts';
import { nextStamp } from './time.ts';
import { uuidv7 } from './ids.ts';

// The record's one way in and out. Writes run one at a time; each one prepares and locks its rows
// first, then makes all its changes in one transaction that holds nothing but storage calls, so a
// save is all or nothing.

/** The open record: what was decrypted, the cipher that opened it, and this device. */
export interface Session {
  readonly cipher: RowCipher;
  /** locks whole backup files; only export and the snapshot at lock use it */
  readonly backup?: BackupCipher;
  readonly model: Model;
  readonly deviceId: string;
  /** the newest change stamp; never stored, worked out at unlock */
  lastWriteMs: number | undefined;
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
  /** one transaction over the given tables; for record/'s own first run and restore */
  commit(tables: readonly TableName[], puts: readonly Put[], check?: Plan<unknown>['check']): Promise<CommitOutcome>;
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

/** The newest change stamp in storage: one lookup on each table's updated_at index, nothing decrypted. */
async function latestStamp(db: RecordDb): Promise<number | undefined> {
  let latest: number | undefined;
  for (const table of SYNCED) {
    const row = (await db.table(table).orderBy('updated_at').last()) as { updated_at: number } | undefined;
    if (row && (latest === undefined || row.updated_at > latest)) latest = row.updated_at;
  }
  return latest;
}

export function openRecord(deps: RecordDeps): RecordCore {
  const { db, now } = deps;
  const serial = writeQueue();
  let session: Session | undefined;

  async function commit(tables: readonly TableName[], puts: readonly Put[], check?: Plan<unknown>['check']): Promise<CommitOutcome> {
    try {
      return await db.transaction('rw', tables.map(t => db.table(t)), async () => {
        const refusal = await check?.();
        if (refusal) throw new Refused(refusal);
        for (const p of puts) await db.table(p.table).put(p.row);
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
      const lastWriteMs = await latestStamp(db);
      const model = await openModel(cipher, raw);
      session = { cipher, backup, model, deviceId: String(device?.value ?? ''), lastWriteMs };
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
      if (plan.puts.length === 0) return saved(plan.value);   // nothing to store: nothing changes, not even the last-write stamp
      const outcome = await commit(spec.tables, plan.puts, plan.check);
      if (outcome === 'quota-full') return quotaFull();
      if (outcome !== 'committed') return outcome;
      s.lastWriteMs = stamp.updated_at;
      plan.apply(s.model);
      return saved(plan.value);
    }),
    serial,
    commit,
  };
}
