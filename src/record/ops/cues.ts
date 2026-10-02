import type { Cue, CueTimes } from '../../rules/cues.ts';
import type { RecordCore } from '../core.ts';
import type { CueRecord } from '../model.ts';
import { cueToParts, defined } from '../mapping.ts';
import { invalid, type Result } from '../results.ts';
import type { Sheet } from '../time.ts';
import { cueProblem } from '../validate.ts';
import { judgedNow, storedRow, tombstone } from './common.ts';

// Reminders: check-ins (at most two a day, capped by the rules) and cues that belong to a habit. A
// reminder keeps the day it was first made on, so editing it never restarts its fade.

export interface CueSave {
  /** made when the sheet opened, so saving twice makes one reminder */
  readonly id: string;
  readonly habitId: string | null;
  readonly kind: 'checkin' | 'cue';
  readonly text: string;
  readonly times: CueTimes;
  readonly fade?: Cue['fade'];
  readonly enabled: boolean;
  readonly private: boolean;
  readonly sheet?: Sheet;
}

export function saveCue(core: RecordCore, input: CueSave): Promise<Result<void>> {
  return core.write({
    tables: ['cues'],
    async prepare(s, stamp) {
      if (input.habitId !== null && !s.model.habits.has(input.habitId)) return invalid('no such habit');
      const cue: CueRecord = defined({
        id: input.id, habitId: input.habitId, kind: input.kind, text: input.text, times: input.times, fade: input.fade,
        enabled: input.enabled, private: input.private,
        createdOn: s.model.cues.get(input.id)?.createdOn ?? judgedNow(core, s, input.sheet).today,
      });
      const problem = cueProblem(cue, s.model.settings.boundary);
      if (problem) return invalid(problem);
      return {
        puts: [{ table: 'cues', row: await storedRow(s.cipher, 'cues', cueToParts(cue), stamp) }],
        apply: m => { m.cues.set(cue.id, cue); },
        value: undefined,
      };
    },
  });
}

export function deleteCue(core: RecordCore, input: { readonly id: string }): Promise<Result<void>> {
  return core.write({
    tables: ['cues'],
    async prepare(s, stamp) {
      const existing = s.model.cues.get(input.id);
      if (!existing) return invalid('no such reminder');
      return { puts: [{ table: 'cues', row: tombstone(cueToParts(existing), stamp) }], apply: m => { m.cues.delete(input.id); }, value: undefined };
    },
  });
}
