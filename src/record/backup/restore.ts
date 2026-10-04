import { BackupError, CipherError, type BackupCipher, type BackupFailure, type Envelope, type EnvelopeContext, type Secret } from '../../vault/cipher.ts';
import { TABLE_TAGS, type LockedTable } from '../../vault/tags.ts';
import { isQuotaFull, type RecordCore } from '../core.ts';
import type { Schema } from '../db.ts';
import { upgradeTables } from '../upgrade.ts';
import type { SnapshotFiles } from '../files.ts';
import { plainOf, rowId } from '../payload.ts';
import type { VaultRow } from '../rows.ts';
import { BODY_TABLES, gunzip, parseBody, type StoredRows } from './body.ts';
import { SAFETY, keepCopy } from './copies.ts';
import { sealBackup } from './export.ts';
import { readFrame, type BackupHeader } from './format.ts';
import { LATEST, writeSnapshot } from './snapshot.ts';

// Restore, in two phases. First everything is checked, outside any transaction: the file opens
// with the secret, its header agrees with its vault, and every locked value inside opens under the
// file's own keys. Then one transaction clears the record and writes the file's rows exactly as
// they are stored.

export interface CheckedBackup {
  readonly header: BackupHeader;
  readonly tables: StoredRows;
}

const LOCKED_TABLES: readonly LockedTable[] = ['settings', 'habits', 'observations', 'days', 'entries', 'notyet', 'cues', 'reviews'];

const damaged = () => new BackupError('damaged');

const isEnvelope = (v: unknown): v is Envelope =>
  typeof v === 'object' && v !== null && typeof (v as Envelope).v === 'number' && typeof (v as Envelope).k === 'string'
  && typeof (v as Envelope).iv === 'string' && typeof (v as Envelope).ct === 'string';

/** Phase 1: opens and checks a backup, writing nothing. Rejects with a BackupError. */
export async function checkBackup(file: Uint8Array, secret: Secret, backupCipher: BackupCipher): Promise<CheckedBackup> {
  const { header, headerBytes, iv, ct } = readFrame(file);
  const opened = await backupCipher.openBody(headerBytes, iv, ct, header.wrappers, secret);
  const tables = parseBody(await gunzip(opened.body));
  const vault = tables.vault[0] as VaultRow | undefined;
  if (tables.vault.length !== 1 || vault?.key !== 'main' || vault.vault_id !== header.vault_id || vault.kid !== header.kid
    || vault.generation !== header.generation || header.wrappers.passphrase.kid !== vault.kid || header.wrappers.recovery.kid !== vault.kid) throw damaged();
  // every row's shape first, so a refusal here leaves no test-open running
  const values: { readonly ctx: EnvelopeContext; readonly env: Envelope }[] = [];
  for (const table of LOCKED_TABLES) {
    for (const row of tables[table] as readonly Record<string, unknown>[]) {
      const slots = (['r', 'w'] as const).filter(slot => row[slot] !== undefined);
      if (row.deleted_at !== undefined && slots.length > 0) throw damaged();     // a tombstone never carries a locked value
      let id: string;
      try {
        id = rowId(table, plainOf(table, row));
      } catch {
        throw damaged();
      }
      for (const slot of slots) {
        const env = row[slot];
        if (!isEnvelope(env)) throw damaged();
        values.push({ ctx: { table: TABLE_TAGS[table], id, slot }, env });
      }
    }
  }
  try {
    // W and R are opened even when the file holds no locked value, so a file whose keys can't be
    // opened as unlock opens them is refused here, before anything is written
    await opened.openKeys(vault);
    await Promise.all(values.map(({ ctx, env }) => opened.testOpen(vault, ctx, env)));
  } catch (e) {
    throw new BackupError(e instanceof CipherError && e.failure === 'newer-app' ? 'newer-app' : 'damaged');
  }
  return { header, tables };
}

export interface RestoreInput {
  readonly file: Uint8Array;
  readonly secret: Secret;
  /** opens the file; it needs no backup key, so it works on a phone never set up */
  readonly backupCipher: BackupCipher;
  /** given when "replace everything" was chosen: the safety copy is kept through these files first */
  readonly replace?: { readonly files: SnapshotFiles; readonly appVersion: string };
  /** the schema versions to bring an older file's rows up to; the app leaves it out */
  readonly schemas?: readonly Schema[];
}

export type RestoreResult =
  | { readonly kind: 'Restored' }
  /** wrong passphrase · needs a newer app · file damaged */
  | { readonly kind: 'Refused'; readonly reason: BackupFailure }
  /** the record has data and "replace everything" wasn't chosen; the question says if the file is another vault's */
  | { readonly kind: 'HasData'; readonly otherVault: boolean }
  | { readonly kind: 'QuotaFull' }
  | { readonly kind: 'Locked' };

/**
 * Restores a backup. Into an empty record any valid file goes; into one with data only when
 * "replace everything" was chosen, after a safety copy. The record ends locked either way.
 */
export async function restore(core: RecordCore, input: RestoreInput): Promise<RestoreResult> {
  let checked: CheckedBackup;
  try {
    checked = await checkBackup(input.file, input.secret, input.backupCipher);
  } catch (e) {
    if (e instanceof BackupError) return { kind: 'Refused', reason: e.reason };
    throw e;
  }
  const replace = input.replace;
  const existing = await core.db.vault.get('main');
  if (existing && !replace) return { kind: 'HasData', otherVault: existing.vault_id !== checked.header.vault_id };
  if (existing && replace) {
    // sealed while the record is still open; then the keys drop, and the copy is written
    const safety = await core.lock(session => sealBackup(core.db, session, core.now(), { appVersion: replace.appVersion }));
    if (!safety) return { kind: 'Locked' };
    await keepCopy(replace.files, SAFETY, core.now(), 'dcbak', safety.bytes);
  }
  const result = await core.serial(() => replaceAll(core, checked.header, upgradeTables(checked.tables, checked.header.schema_version, input.schemas), replace !== undefined));
  if (result.kind === 'Restored' && replace) await becomeLatest(replace.files, input.file);
  return result;
}

/**
 * After "replace everything", the file just restored becomes the latest snapshot: it is a sealed
 * backup of exactly the rows now stored, and the old latest holds the data that was replaced. If it
 * can't be written, the old latest is removed, so the next lock writes a fresh one.
 */
async function becomeLatest(files: SnapshotFiles, file: Uint8Array): Promise<void> {
  try {
    await writeSnapshot(files, { bytes: file });
  } catch {
    await files.remove(LATEST).catch(() => {});
  }
}

/** Phase 2: one transaction that clears and adds. A failed add is never caught, so it undoes everything. */
async function replaceAll(core: RecordCore, header: BackupHeader, tables: StoredRows, replacing: boolean): Promise<RestoreResult> {
  const { db } = core;
  const deviceId = core.newId();
  const cleared = [...BODY_TABLES, 'wrappers', 'migrations'] as const;
  try {
    return await db.transaction('rw', [...cleared, 'device'].map(t => db.table(t)), async (): Promise<RestoreResult> => {
      const now = await db.vault.get('main');
      if (now && !replacing) return { kind: 'HasData', otherVault: now.vault_id !== header.vault_id };
      for (const t of cleared) await db.table(t).clear();
      for (const t of BODY_TABLES) await db.table(t).bulkAdd([...tables[t]]);
      await db.wrappers.bulkAdd([header.wrappers.passphrase, header.wrappers.recovery]);
      if (!(await db.device.get('device_id'))) await db.device.add({ key: 'device_id', value: deviceId });
      return { kind: 'Restored' };
    });
  } catch (e) {
    if (isQuotaFull(e)) return { kind: 'QuotaFull' };
    throw e;
  }
}
