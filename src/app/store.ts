import type { RecordCore } from '../record/core.ts';
import type { Result } from '../record/results.ts';

// How the screens learn that the record changed. The open record's model is changed in place once
// a write commits, so React can't see it; every write a screen asks for goes through run(), and a
// Saved moves a revision number on. The screens re-read the model whenever it moves.

export interface RecordStore {
  /** moves on after every Saved, every unlock and every lock */
  readonly revision: () => number;
  subscribe(listener: () => void): () => void;
  /** runs one write; on Saved the revision moves on. The result comes back as the write returned it. */
  run<T>(write: (core: RecordCore) => Promise<Result<T>>): Promise<Result<T>>;
  /** the lock changed state: the model appeared or went */
  changed(): void;
}

export function recordStore(core: RecordCore): RecordStore {
  let revision = 0;
  const listeners = new Set<() => void>();

  const changed = () => {
    revision += 1;
    for (const listener of [...listeners]) {
      try {
        listener();
      } catch {
        // a screen that fails to draw never stops the others hearing
      }
    }
  };

  return {
    revision: () => revision,
    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    async run(write) {
      const result = await write(core);
      if (result.kind === 'Saved') changed();
      return result;
    },
    changed,
  };
}
