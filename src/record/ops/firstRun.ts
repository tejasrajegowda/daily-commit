import type { RowCipher } from '../../vault/cipher.ts';
import type { Put, RecordCore } from '../core.ts';
import type { Settings } from '../model.ts';
import type { SettingRow, VaultRow, WrapperRow } from '../rows.ts';
import { settingEntries, settingToParts } from '../mapping.ts';
import { sealParts } from '../payload.ts';
import { invalid, quotaFull, saved, type Result } from '../results.ts';
import { settingsProblem } from '../validate.ts';

export interface FirstRunInput {
  /** the cipher made from the new keys */
  readonly cipher: RowCipher;
  readonly vault: VaultRow;
  /** the passphrase copy and the recovery-code copy */
  readonly wrappers: readonly WrapperRow[];
  readonly settings: Settings;
}

/**
 * Writes the whole first run in one transaction, after the recovery code has been typed back: the
 * vault, both wrappers, the first settings and this device's id. A crash before it leaves nothing,
 * so "a vault row exists" means first run finished. Then the record is open.
 */
export async function firstRun(core: RecordCore, input: FirstRunInput): Promise<Result<void>> {
  const problem = settingsProblem(input.settings);
  if (problem) return invalid(problem);
  if (input.wrappers.length !== 2 || new Set(input.wrappers.map(w => w.method)).size !== 2) return invalid('needs one passphrase copy and one recovery copy');
  const deviceId = core.newId();
  const stamp = { updated_at: core.now(), updated_by: deviceId };
  const settingPuts = await Promise.all(settingEntries(input.settings).map(async ([name, value]): Promise<Put> => {
    const parts = settingToParts(name, value);
    const row: SettingRow = { key: parts.plain.key ?? '', ...stamp, ...(await sealParts(input.cipher, 'settings', parts)) };
    return { table: 'settings', row };
  }));
  const puts: Put[] = [
    ...input.wrappers.map((row): Put => ({ table: 'wrappers', row })),
    { table: 'vault', row: input.vault },
    ...settingPuts,
    { table: 'device', row: { key: 'device_id', value: deviceId } },
  ];
  const outcome = await core.serial(() => core.commit(['wrappers', 'vault', 'settings', 'device'], puts,
    async () => ((await core.db.vault.count()) > 0 ? invalid('already set up') : undefined)));
  if (outcome === 'quota-full') return quotaFull();
  if (outcome !== 'committed') return outcome;
  await core.unlock(input.cipher);
  return saved(undefined);
}
