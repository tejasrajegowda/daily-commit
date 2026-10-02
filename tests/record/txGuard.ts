import Dexie from 'dexie';
import type { RowCipher } from '../../src/vault/cipher.ts';

/**
 * Wraps a cipher so a call made while a storage transaction is open fails at once. A real browser
 * would end the transaction early; the test database would not notice at all. So every record
 * test runs its cipher through this guard.
 */
export function guarded(cipher: RowCipher): RowCipher {
  const check = (call: string) => {
    if (Dexie.currentTransaction) throw new Error(`cipher.${call} was called inside a storage transaction`);
  };
  return {
    seal: (ctx, plain) => { check('seal'); return cipher.seal(ctx, plain); },
    open: (ctx, env) => { check('open'); return cipher.open(ctx, env); },
  };
}
