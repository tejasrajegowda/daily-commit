import type { EnvelopeContext } from './cipher.ts';
import { utf8Bytes } from './encoding.ts';

// What every locked value is bound to. An AAD is the bytes "dc1", then each part as UTF-8 text
// behind a 2-byte big-endian length. The first part names the purpose, so a value made for one
// purpose never opens as another. Numbers are written in decimal and ids exactly as stored
// (base64url), so an AAD is built from the stored text with nothing decoded first. The purposes
// are frozen: changing one would stop every value already stored from opening.

const PREFIX = utf8Bytes('dc1');
const MAX_PART = 0xffff;

export const PURPOSES = Object.freeze({ env: 'env', wrap: 'wrap', dk: 'dk' } as const);

/** The AAD for a list of parts, the purpose first. */
export function aad(parts: readonly string[]): Uint8Array<ArrayBuffer> {
  const encoded = parts.map(utf8Bytes);
  for (const part of encoded) if (part.length > MAX_PART) throw new RangeError('an AAD part is longer than 65,535 bytes');
  const out = new Uint8Array(PREFIX.length + encoded.reduce((n, p) => n + 2 + p.length, 0));
  out.set(PREFIX);
  let at = PREFIX.length;
  for (const part of encoded) {
    out[at] = part.length >> 8;
    out[at + 1] = part.length & 0xff;
    out.set(part, at + 2);
    at += 2 + part.length;
  }
  return out;
}

/** A row's locked value: bound to its format version, its key, its table, its row and its slot. */
export function envAad(v: number, k: string, ctx: EnvelopeContext): Uint8Array<ArrayBuffer> {
  return aad([PURPOSES.env, String(v), k, ctx.table, ctx.id, ctx.slot]);
}

/** A portable copy of the master key: bound to how it opens, which master key, and its KDF settings. */
export function wrapAad(method: 'passphrase' | 'recovery', kid: string, kdf: object): Uint8Array<ArrayBuffer> {
  return aad([PURPOSES.wrap, method, kid, sortedJson(kdf)]);
}

/** The words key or the record key under the master key: bound to its own id and the master key's. */
export function dkAad(v: number, dataKeyId: string, kid: string): Uint8Array<ArrayBuffer> {
  return aad([PURPOSES.dk, String(v), dataKeyId, kid]);
}

/** JSON with every object's keys sorted, at every depth; arrays keep their order. */
export function sortedJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (typeof value !== 'object' || value === null) return value;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) out[key] = sortKeys((value as Record<string, unknown>)[key]);
  return out;
}
