import type { RecordCore } from '../core.ts';
import type { Settings } from '../model.ts';
import type { SettingRow } from '../rows.ts';
import { settingToParts } from '../mapping.ts';
import { sealParts } from '../payload.ts';
import { invalid, type Result } from '../results.ts';
import { settingProblem } from '../validate.ts';

/** Saves one setting, locked, and updates the open record once it is stored. */
export function setSetting<K extends keyof Settings>(core: RecordCore, name: K, value: Settings[K]): Promise<Result<void>> {
  return core.write({
    tables: ['settings'],
    async prepare(session, stamp) {
      const problem = settingProblem(name, value);
      if (problem) return invalid(`${name}: ${problem}`);
      const parts = settingToParts(name, value);
      const row: SettingRow = { key: parts.plain.key ?? '', ...stamp, ...(await sealParts(session.cipher, 'settings', parts)) };
      return {
        puts: [{ table: 'settings', row }],
        apply: model => { model.settings = { ...model.settings, [name]: value }; },
        value: undefined,
      };
    },
  });
}
