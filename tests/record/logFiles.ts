import assert from 'node:assert/strict';
import type { Secret } from '../../src/vault/cipher.ts';
import type { RecordCore } from '../../src/record/core.ts';
import type { RecordDb } from '../../src/record/db.ts';
import type { ChangeRow } from '../../src/record/rows.ts';
import { closeSession, openSession } from '../../src/record/ops/session.ts';
import { setSetting } from '../../src/record/ops/settings.ts';
import { gunzip, parseBody } from '../../src/record/backup/body.ts';
import { FORMAT, LOG_FORMAT, readFrame, type BackupHeader } from '../../src/record/backup/format.ts';
import { LOG_ARCHIVE, LOG_DIR, digestOf, parseCursor, parseMonth } from '../../src/record/backup/monthLog.ts';
import { LATEST } from '../../src/record/backup/snapshot.ts';
import type { memoryFiles } from './memoryFiles.ts';
import { STUB_SECRETS, stubBackup } from './stubBackup.ts';
import { stubCipher } from './stubCipher.ts';
import { guarded, guardedBackup } from './txGuard.ts';

// What the tests of the change log's files share: locking and opening, and reading back what the
// automatic copy and its month files hold, with the stand-in ciphers.

export const PASS: Secret = { method: 'passphrase', text: STUB_SECRETS.passphrase };
export type Files = ReturnType<typeof memoryFiles>;
export const never = () => new Promise<void>(() => {});
export const reopen = (core: RecordCore) => openSession(core, guarded(stubCipher()), guardedBackup(stubBackup()));
export const close = (core: RecordCore, m: Files, sleep: (ms: number) => Promise<void> = never) => closeSession(core, { files: m.files, sleep, appVersion: '0.1.0' });

/** The ids of the lines a backup or a month file holds, opened with the stand-in. */
export async function idsIn(file: Uint8Array | undefined, format: BackupHeader['format'] = FORMAT): Promise<string[]> {
  if (!file) throw new Error('no such file');
  const f = readFrame(file, format);
  const opened = await stubBackup().openBody(f.headerBytes, f.iv, f.ct, f.header.wrappers, PASS);
  const body = await gunzip(opened.body);
  const rows = format === LOG_FORMAT ? parseMonth(body) : (parseBody(body, f.header.schema_version).changes as readonly ChangeRow[]);
  return rows.map(r => r.id).sort();
}

/** Every line a restore of the phone's copy could bring back: latest's, and those of each month file it names that is there unchanged. */
export async function recoverable(m: Files): Promise<Set<string>> {
  const latest = m.store.get(LATEST);
  const out = new Set(await idsIn(latest));
  for (const f of readFrame(latest ?? new Uint8Array()).header.log_files ?? []) {
    const bytes = m.store.get(`${LOG_DIR}/${f.name}`);
    if (bytes && (await digestOf(bytes)) === f.sha256) for (const id of await idsIn(bytes, LOG_FORMAT)) out.add(id);
  }
  return out;
}

export const ids = async (db: RecordDb, keep: (line: ChangeRow) => boolean = () => true) => (await db.changes.toArray()).filter(keep).map(r => r.id).sort();
export const cursorOf = async (db: RecordDb) => parseCursor((await db.device.get(LOG_ARCHIVE))?.value);
export const monthFiles = (m: Files) => [...m.store.keys()].filter(p => p.startsWith(`${LOG_DIR}/`)).sort();

/** Each call opens the record and changes one setting, so the next lock seals a snapshot. */
export function changer(core: RecordCore) {
  let n = 400;
  return async () => {
    await reopen(core);
    const saved = await setSetting(core, 'wakePlan', n++);
    if (saved.kind !== 'Saved') throw new Error(saved.kind);
  };
}

/** Asserts a write was stored. */
export async function must(result: Promise<{ readonly kind: string }>): Promise<void> {
  assert.equal((await result).kind, 'Saved');
}
