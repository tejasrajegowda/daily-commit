import type { Random } from './random.ts';

// The recovery code on paper: 200 random bits as 40 Crockford Base32 characters in 8 groups of 5,
// then one check symbol, the whole number modulo 37. Reading it back forgives what people do with
// paper: any case, I or L for 1, O for 0, and spaces or dashes anywhere.

export const RECOVERY_BYTES = 25;
const CHARS = 40;
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const CHECK = ALPHABET + '*~$=U';

export interface RecoveryCode {
  /** as printed: `XXXXX XXXXX … XXXXX C` */
  readonly text: string;
  /** the 25 bytes it stands for */
  readonly bytes: Uint8Array;
}

/** Why typed text is not a recovery code; the screen says which. */
export type CodeProblem = 'length' | 'character' | 'check';

export type ReadCode = { readonly ok: true; readonly bytes: Uint8Array } | { readonly ok: false; readonly problem: CodeProblem };

const toNumber = (bytes: Uint8Array): bigint => bytes.reduce((n, b) => (n << 8n) | BigInt(b), 0n);

function toBytes(n: bigint): Uint8Array {
  const out = new Uint8Array(RECOVERY_BYTES);
  for (let i = RECOVERY_BYTES - 1; i >= 0; i--, n >>= 8n) out[i] = Number(n & 0xffn);
  return out;
}

/** The printed form of 25 bytes. */
export function printCode(bytes: Uint8Array): string {
  if (bytes.length !== RECOVERY_BYTES) throw new RangeError('a recovery code is 25 bytes');
  const n = toNumber(bytes);
  let chars = '';
  for (let i = CHARS - 1; i >= 0; i--) chars += ALPHABET[Number((n >> BigInt(5 * i)) & 31n)];
  const groups = chars.match(/.{5}/g) ?? [];
  return `${groups.join(' ')} ${CHECK[Number(n % 37n)]}`;
}

/** A new recovery code. */
export function newRecoveryCode(random: Random): RecoveryCode {
  const bytes = random(RECOVERY_BYTES);
  return { text: printCode(bytes), bytes };
}

/** Reads a typed recovery code back into its bytes, or says what is wrong with it. */
export function readCode(typed: string): ReadCode {
  const s = typed.replace(/[\s-]/g, '').toUpperCase().replace(/[IL]/g, '1').replace(/O/g, '0');
  if (s.length !== CHARS + 1) return { ok: false, problem: 'length' };
  let n = 0n;
  for (const c of s.slice(0, CHARS)) {
    const v = ALPHABET.indexOf(c);
    if (v < 0) return { ok: false, problem: 'character' };
    n = (n << 5n) | BigInt(v);
  }
  const check = CHECK.indexOf(s.charAt(CHARS));
  if (check < 0) return { ok: false, problem: 'character' };
  if (BigInt(check) !== n % 37n) return { ok: false, problem: 'check' };
  return { ok: true, bytes: toBytes(n) };
}
