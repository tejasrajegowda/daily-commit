import { CipherError } from './cipher.ts';
import { fromBase64url, toBase64url, utf8Bytes } from './encoding.ts';
import type { Random } from './random.ts';

// How a passphrase or a recovery code becomes a key that opens a copy of the master key (a KEK).
// New copies always use the constants below. Settings read from storage or a file are used only to
// open an old copy, and are checked first: a file could ask for billions of rounds and freeze the
// phone, so anything outside what an app has ever written is refused before any work is done.

export const PBKDF2_ITERATIONS = 600_000;
/** More rounds than this: a later app may have raised the count; this one does not try. */
export const MAX_ITERATIONS = 10_000_000;
export const SALT_BYTES = 16;
export const NORM = 'utf8-nfc-trim-v1';
export const RECOVERY_INFO = 'dc/recovery/v1';

/** How a KEK is made; stored beside each copy of the master key. */
export type KdfSettings =
  | { readonly alg: 'pbkdf2-sha256'; readonly iterations: number; readonly salt: string; readonly norm: typeof NORM }
  | { readonly alg: 'hkdf-sha256'; readonly salt: string; readonly info: typeof RECOVERY_INFO };

/** Settings for a new passphrase copy. */
export function newPassphraseKdf(random: Random): KdfSettings {
  return { alg: 'pbkdf2-sha256', iterations: PBKDF2_ITERATIONS, salt: toBase64url(random(SALT_BYTES)), norm: NORM };
}

/** Settings for a new recovery-code copy. */
export function newRecoveryKdf(random: Random): KdfSettings {
  return { alg: 'hkdf-sha256', salt: toBase64url(random(SALT_BYTES)), info: RECOVERY_INFO };
}

function saltOk(salt: unknown): boolean {
  if (typeof salt !== 'string') return false;
  try {
    return fromBase64url(salt).length === SALT_BYTES;
  } catch {
    return false;
  }
}

/**
 * Checks stored settings before any work. Damaged: no app ever wrote them. Newer app: a later app
 * may have; this one doesn't know how to use them.
 */
export function checkKdf(kdf: unknown): 'ok' | 'damaged' | 'newer-app' {
  if (typeof kdf !== 'object' || kdf === null) return 'damaged';
  const k = kdf as Record<string, unknown>;
  if (typeof k.alg !== 'string') return 'damaged';
  if (k.alg === 'pbkdf2-sha256') {
    if (k.norm !== NORM) return typeof k.norm === 'string' ? 'newer-app' : 'damaged';
    if (typeof k.iterations !== 'number' || !Number.isInteger(k.iterations) || k.iterations < PBKDF2_ITERATIONS) return 'damaged';
    if (k.iterations > MAX_ITERATIONS) return 'newer-app';
    return saltOk(k.salt) ? 'ok' : 'damaged';
  }
  if (k.alg === 'hkdf-sha256') {
    if (k.info !== RECOVERY_INFO) return typeof k.info === 'string' ? 'newer-app' : 'damaged';
    return saltOk(k.salt) ? 'ok' : 'damaged';
  }
  return 'newer-app';
}

/** A passphrase as the bytes it is stretched from: NFC, then trimmed, then UTF-8. */
export function passphraseBytes(text: string): Uint8Array<ArrayBuffer> {
  return utf8Bytes(text.normalize('NFC').trim());
}

/**
 * The fewest characters a new passphrase may have: the floor NIST SP 800-63B-4 sets when a password
 * is the only thing that opens something. Five ordinary words clear it.
 */
export const MIN_PASSPHRASE_CHARS = 15;

/** A passphrase's length as it will be stretched: characters (code points) after NFC and trimming. */
export function passphraseLength(text: string): number {
  return [...text.normalize('NFC').trim()].length;
}

const KEK_USE = { name: 'AES-GCM', length: 256 } as const;

/** What was typed: the passphrase's text, or a recovery code's 25 bytes. */
export type KekSecret = { readonly passphrase: string } | { readonly code: Uint8Array };

/**
 * The KEK that opens a copy of the master key. Settings that fail checkKdf, or that belong to the
 * other kind of secret, reject with a CipherError before any work. The secret's bytes are
 * zero-filled once they are used; the caller's own copy of a code is left alone.
 */
export async function deriveKek(kdf: unknown, secret: KekSecret): Promise<CryptoKey> {
  const verdict = checkKdf(kdf);
  if (verdict !== 'ok') throw new CipherError(verdict);
  const k = kdf as KdfSettings;
  const isPassphrase = 'passphrase' in secret;
  if (isPassphrase !== (k.alg === 'pbkdf2-sha256')) throw new CipherError('damaged');
  const bytes = 'passphrase' in secret ? passphraseBytes(secret.passphrase) : secret.code.slice();
  try {
    const salt = fromBase64url(k.salt);
    const params = k.alg === 'pbkdf2-sha256'
      ? { name: 'PBKDF2', hash: 'SHA-256', salt, iterations: k.iterations }
      : { name: 'HKDF', hash: 'SHA-256', salt, info: utf8Bytes(k.info) };
    const base = await crypto.subtle.importKey('raw', bytes, params.name, false, ['deriveKey']);
    return await crypto.subtle.deriveKey(params, base, KEK_USE, false, ['encrypt', 'decrypt']);
  } finally {
    bytes.fill(0);
  }
}
