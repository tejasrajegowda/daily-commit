import Dexie from 'dexie';
import type { BackupCipher, RowCipher } from '../../src/vault/cipher.ts';

// A cipher call made while a storage transaction is open fails at once. A real browser would end
// the transaction early; the test database would not notice at all. So every record test runs its
// ciphers through these guards.

function outside(call: string): void {
  if (Dexie.currentTransaction) throw new Error(`cipher.${call} was called inside a storage transaction`);
}

/** The guard around a row cipher. */
export function guarded(cipher: RowCipher): RowCipher {
  return {
    seal: (ctx, plain) => { outside('seal'); return cipher.seal(ctx, plain); },
    open: (ctx, env) => { outside('open'); return cipher.open(ctx, env); },
  };
}

/** The same guard around the whole-file cipher. */
export function guardedBackup(cipher: BackupCipher): BackupCipher {
  return {
    sealBody: (body, header, iv) => { outside('sealBody'); return cipher.sealBody(body, header, iv); },
    openBody: (header, iv, ct, wraps, secret) => { outside('openBody'); return cipher.openBody(header, iv, ct, wraps, secret); },
  };
}
