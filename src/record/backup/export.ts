import type { RecordCore, Session } from '../core.ts';
import { SCHEMA_VERSION, type RecordDb } from '../db.ts';
import type { VaultRow } from '../rows.ts';
import { toBase64url } from '../bytes.ts';
import { locked, saved, type Result } from '../results.ts';
import { appDay } from '../time.ts';
import { bodyJson, gzip, readRaw } from './body.ts';
import { FORMAT, FORMAT_VERSION, frame, headerBytes, type BackupHeader } from './format.ts';

// A whole backup, made from the rows exactly as stored. Nothing is decrypted to make it: each
// row's locked values are copied as they are, and the body is locked once more as a whole.

export interface BackupOptions {
  /** the app's version, written into the header */
  readonly appVersion: string;
  /** the body's IV; tests pass a fixed one, the app leaves it out and gets 12 fresh random bytes */
  readonly iv?: Uint8Array;
}

export interface SealedBackup {
  readonly bytes: Uint8Array;
  readonly header: BackupHeader;
}

/**
 * Seals a backup of everything now in storage. The caller already holds a turn in the write
 * queue, so no write lands while it reads.
 */
export async function sealBackup(db: RecordDb, session: Session, now: number, options: BackupOptions): Promise<SealedBackup> {
  const backup = session.backup;
  if (!backup) throw new Error('this session has no backup key');
  const raw = await readRaw(db);
  const vault = raw.tables.vault[0] as VaultRow | undefined;
  const passphrase = raw.wrappers.find(w => w.method === 'passphrase');
  const recovery = raw.wrappers.find(w => w.method === 'recovery');
  if (!vault || !passphrase || !recovery) throw new Error('the vault is incomplete');
  const iv = options.iv ?? crypto.getRandomValues(new Uint8Array(12));
  const header: BackupHeader = {
    format: FORMAT, format_version: FORMAT_VERSION, schema_version: SCHEMA_VERSION, app_version: options.appVersion,
    // on the change-stamp scale, so it is never behind the newest row, even with the clock set back
    exported_at: Math.max(now, session.lastWriteMs ?? now),
    vault_id: vault.vault_id, kid: vault.kid, generation: vault.generation, iv: toBase64url(iv),
    wrappers: { passphrase, recovery },
  };
  const head = headerBytes(header);
  const ct = await backup.sealBody(await gzip(bodyJson(raw.tables)), head, iv);
  return { bytes: frame(head, ct), header };
}

export interface ExportedFile {
  readonly bytes: Uint8Array;
  /** `backup-YYYY-MM-DD.dcbak`, by the app day it was made on */
  readonly name: string;
}

/** The manual export, for the system "save as" picker. It needs the record unlocked. */
export function exportBackup(core: RecordCore, options: BackupOptions): Promise<Result<ExportedFile>> {
  return core.serial(async (): Promise<Result<ExportedFile>> => {
    const session = core.session;
    if (!session) return locked();
    const { bytes, header } = await sealBackup(core.db, session, core.now(), options);
    return saved({ bytes, name: `backup-${appDay(header.exported_at, session.model.settings)}.dcbak` });
  });
}
