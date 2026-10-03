import type { RecordCore } from '../core.ts';
import type { VaultRow, WrapperRow } from '../rows.ts';
import { invalid, type Result } from '../results.ts';

// The vault's own plain rows: read before unlock, so the lock has something to open, and changed
// only when the passphrase or the recovery code is replaced. Nothing here sees a key.

export interface VaultRows {
  readonly vault: VaultRow;
  readonly passphrase: WrapperRow;
  readonly recovery: WrapperRow;
}

/** The vault row and both copies of the master key, read with nothing decrypted; undefined before first run. */
export async function vaultRows(core: RecordCore): Promise<VaultRows | undefined> {
  const { db } = core;
  const [vault, passphrase, recovery] = await db.transaction('r', [db.vault, db.wrappers], () =>
    Promise.all([db.vault.get('main'), db.wrappers.get('passphrase'), db.wrappers.get('recovery')]));
  if (!vault) return undefined;
  if (!passphrase || !recovery) throw new Error('the vault is incomplete');
  return { vault, passphrase, recovery };
}

/**
 * Stores a new copy of the master key in place of the old one, and moves the vault to the copy's
 * generation, in one write. The copy has already been opened and checked when it was made. The
 * record must be open; the write marks the session changed, so the next lock takes a snapshot.
 */
export function replaceWrapper(core: RecordCore, wrap: WrapperRow): Promise<Result<void>> {
  return core.write({
    tables: ['wrappers', 'vault'],
    async prepare(_session, stamp) {
      const vault = await core.db.vault.get('main');
      if (!vault) return invalid('no vault');
      if (wrap.kid !== vault.kid) return invalid('a copy of another master key');
      if (wrap.generation !== vault.generation + 1) return invalid('not the next generation');
      const row: WrapperRow = { ...wrap, updated_at: stamp.updated_at };
      const next: VaultRow = { ...vault, generation: wrap.generation, updated_at: stamp.updated_at };
      return {
        puts: [{ table: 'wrappers', row }, { table: 'vault', row: next }],
        check: async () => ((await core.db.vault.get('main'))?.generation === vault.generation ? undefined : invalid('the vault changed meanwhile')),
        apply: () => {},
        value: undefined,
      };
    },
  });
}
