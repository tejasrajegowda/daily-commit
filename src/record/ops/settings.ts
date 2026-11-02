import type { RecordCore } from '../core.ts';
import type { Settings } from '../model.ts';
import type { SettingRow } from '../rows.ts';
import { settingToParts } from '../mapping.ts';
import { sealParts } from '../payload.ts';
import { invalid, type Result } from '../results.ts';
import { settingProblem } from '../validate.ts';
import { appDay, todayOf } from '../time.ts';
import { dayRule } from './common.ts';

/**
 * Saves one setting, locked, and updates the open record once it is stored. A change of timezone or
 * boundary that would make today an earlier day is refused, so it can't reopen a closed day.
 * Day 1 (journeyStart) is never changed here: first run writes it, a restore brings it back.
 */
export function setSetting<K extends keyof Settings>(core: RecordCore, name: K, value: Settings[K]): Promise<Result<void>> {
  return core.write({
    tables: ['settings'],
    async prepare(session, stamp) {
      // Day 1 is set once, by first run, and moves for nothing: not earlier, not later, not to itself
      if (name === 'journeyStart') return invalid('journeyStart: Day 1 never moves');
      const problem = settingProblem(name, value);
      if (problem) return invalid(`${name}: ${problem}`);
      if (name === 'tz' || name === 'boundary') {
        const before = dayRule(session);
        const after = { ...before, [name]: value };
        // this save becomes the last write, so under the new rule today is the day of its stamp
        if (appDay(stamp.updated_at, after) < todayOf(stamp.updated_at, session.lastWriteMs, before)) {
          return invalid(`${name}: today would become an earlier day; try again once the new day has started`);
        }
      }
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
