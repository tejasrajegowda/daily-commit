// Shared set-up for the lock's tests: the golden vault, made once per test file, and its pieces.
import { createVault, type NewVault } from '../../src/vault/keys.ts';
import { counterRandom, GOLDEN_MADE, GOLDEN_PASSPHRASE } from './vectors.ts';

let golden: Promise<NewVault> | undefined;

/** The vault the reference also made: fixed keys, fixed ids, one 600,000-round stretch. */
export function goldenVault(): Promise<NewVault> {
  golden ??= createVault(GOLDEN_PASSPHRASE, counterRandom(), GOLDEN_MADE);
  return golden;
}

/** A vault no test has seen, from the system's random source. */
export function freshVault(passphrase = 'CANARY other passphrase'): Promise<NewVault> {
  return createVault(passphrase, n => crypto.getRandomValues(new Uint8Array(n)), GOLDEN_MADE);
}

export const hex = (b: Uint8Array): string => Buffer.from(b).toString('hex');
export const utf8 = (text: string): Uint8Array<ArrayBuffer> => new TextEncoder().encode(text);

/** A copy of base64url text with one byte changed. */
export function flipByte(text: string, at = 0): string {
  const bytes = Buffer.from(text, 'base64url');
  bytes[at] = (bytes[at] ?? 0) ^ 0x01;
  return bytes.toString('base64url');
}
