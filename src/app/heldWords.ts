import type { Result } from '../record/results.ts';
import { resultWords } from './resultWords.ts';

// Words whose save didn't go through, held for the visit. The tap that leaves a field is usually the
// tap that leaves its screen, so the answer to its save can come after the screen has gone; the
// words are held here instead, and come back in their field, with the words for why, when that
// field is shown again. In memory only: never written anywhere, and all of it goes at a lock.

export interface Held {
  /** the words as they were typed */
  readonly text: string;
  /** why they weren't saved */
  readonly note: { readonly title: string; readonly text: string };
}

export interface HeldWords {
  /** moves on whenever words are held or let go */
  readonly revision: () => number;
  subscribe(listener: () => void): () => void;
  get(key: string): Held | undefined;
  /** runs the save of `text`: a refusal, or a write that throws, holds the words under `key`; Saved lets go of them. True once saved. */
  keep(key: string, text: string, write: () => Promise<Result<unknown>>): Promise<boolean>;
  /** the field holds what the record holds again: nothing to keep under `key` */
  drop(key: string): void;
  /** the lock: everything held goes, and answers still on their way are not heard */
  clear(): void;
}

// A write that fails outright gets the same shape of words as a refusal, so it never goes unsaid.
const NOT_SAVED = { title: 'Not saved', text: "That couldn't be saved. What you wrote is still here." };

export function heldWords(): HeldWords {
  const held = new Map<string, Held>();
  // the newest save asked for under each key; an older answer is not heard
  const asked = new Map<string, number>();
  let count = 0;
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
    get: key => held.get(key),
    async keep(key, text, write) {
      const mine = ++count;
      asked.set(key, mine);
      let result: Result<unknown> | undefined;
      try {
        result = await write();
      } catch {
        result = undefined;
      }
      const saved = result?.kind === 'Saved';
      // newer words went out after these and carry them, or the record locked meanwhile
      if (asked.get(key) !== mine) return saved;
      asked.delete(key);
      if (saved) {
        if (held.delete(key)) changed();
        return true;
      }
      if (result?.kind === 'Locked') return false;      // nothing is held across a lock
      held.set(key, { text, note: (result && resultWords(result)) ?? NOT_SAVED });
      changed();
      return false;
    },
    drop(key) {
      asked.delete(key);
      if (held.delete(key)) changed();
    },
    clear() {
      asked.clear();
      if (held.size === 0) return;
      held.clear();
      changed();
    },
  };
}
