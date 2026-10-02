import { BackupError } from '../../vault/cipher.ts';
import { fromBase64url, jsonBytes, parseJsonBytes } from '../bytes.ts';
import { SCHEMA_VERSION } from '../db.ts';
import type { WrapperRow } from '../rows.ts';

// The .dcbak file, fixed to the byte: the 4 bytes "DCBK", the header's length as 4 bytes
// big-endian, the header as UTF-8 JSON, then the body's ciphertext with its 16-byte tag. Format 1
// never changes: every later app reads it as it is.

export const MAGIC = Uint8Array.of(0x44, 0x43, 0x42, 0x4b);   // "DCBK"
export const FORMAT = 'daily-commit-backup';
export const FORMAT_VERSION = 1;
const TAG_BYTES = 16;
const IV_BYTES = 12;

export interface BackupHeader {
  readonly format: typeof FORMAT;
  readonly format_version: number;
  readonly schema_version: number;
  readonly app_version: string;
  /** when it was made, on the change-stamp scale, so it is never behind the newest row */
  readonly exported_at: number;
  readonly vault_id: string;
  readonly kid: string;
  readonly generation: number;
  /** the body's IV, base64url; it sits in the header, so the seal covers it */
  readonly iv: string;
  /** the portable copies of the master key, each exactly as its `wrappers` row is stored */
  readonly wrappers: { readonly passphrase: WrapperRow; readonly recovery: WrapperRow };
}

/** The header as bytes, its keys always in the same order. */
export function headerBytes(h: BackupHeader): Uint8Array {
  return jsonBytes({
    format: h.format, format_version: h.format_version, schema_version: h.schema_version, app_version: h.app_version,
    exported_at: h.exported_at, vault_id: h.vault_id, kid: h.kid, generation: h.generation, iv: h.iv,
    wrappers: { passphrase: h.wrappers.passphrase, recovery: h.wrappers.recovery },
  });
}

/** A whole file: "DCBK", the header's length, the header, the body. */
export function frame(header: Uint8Array, body: Uint8Array): Uint8Array {
  const out = new Uint8Array(8 + header.length + body.length);
  out.set(MAGIC);
  new DataView(out.buffer).setUint32(4, header.length);
  out.set(header, 8);
  out.set(body, 8 + header.length);
  return out;
}

export interface Framed {
  readonly header: BackupHeader;
  /** the header exactly as read from the file: the seal is checked against these bytes */
  readonly headerBytes: Uint8Array;
  readonly iv: Uint8Array;
  /** the body's ciphertext with its tag */
  readonly ct: Uint8Array;
}

const damaged = () => new BackupError('damaged');

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

const isWrap = (v: unknown, method: string): boolean =>
  isObject(v) && v.method === method && typeof v.kid === 'string' && typeof v.generation === 'number'
  && isObject(v.kdf) && typeof v.iv === 'string' && typeof v.ct === 'string';

function parsed(bytes: Uint8Array): unknown {
  try {
    return parseJsonBytes(bytes);
  } catch {
    return undefined;
  }
}

function ivOf(text: unknown): Uint8Array | undefined {
  if (typeof text !== 'string') return undefined;
  try {
    const iv = fromBase64url(text);
    return iv.length === IV_BYTES ? iv : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Reads a file's frame and its plain header, opening nothing. A file cut short, a broken frame or
 * a header that isn't one is damaged; a later format or schema needs a newer app.
 */
export function readFrame(file: Uint8Array): Framed {
  if (file.length < 8 || !MAGIC.every((b, i) => file[i] === b)) throw damaged();
  const length = new DataView(file.buffer, file.byteOffset, file.byteLength).getUint32(4);
  if (8 + length + TAG_BYTES > file.length) throw damaged();
  const headerBytes = file.slice(8, 8 + length);
  const h = parsed(headerBytes);
  if (!isObject(h) || h.format !== FORMAT) throw damaged();
  const formatVersion = h.format_version, schemaVersion = h.schema_version;
  if (typeof formatVersion !== 'number' || typeof schemaVersion !== 'number') throw damaged();
  if (formatVersion > FORMAT_VERSION || schemaVersion > SCHEMA_VERSION) throw new BackupError('newer-app');
  if (formatVersion !== FORMAT_VERSION || !Number.isInteger(schemaVersion) || schemaVersion < 1) throw damaged();
  const w = h.wrappers;
  if (typeof h.app_version !== 'string' || typeof h.exported_at !== 'number' || typeof h.vault_id !== 'string'
    || typeof h.kid !== 'string' || typeof h.generation !== 'number'
    || !isObject(w) || !isWrap(w.passphrase, 'passphrase') || !isWrap(w.recovery, 'recovery')) throw damaged();
  const iv = ivOf(h.iv);
  if (!iv) throw damaged();
  return { header: h as unknown as BackupHeader, headerBytes, iv, ct: file.slice(8 + length) };
}
