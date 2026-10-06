// The fields that save when they are left. The app can be left while one of them still has focus
// (the screen going off mid-sentence): the lock joins the write queue at once and refuses any save
// asked for after it, and React never calls a removed field's blur. So each such field adds its
// save here while it is on screen, and a leave runs them before the lock: the words still in the
// field are queued ahead of it, and saved under the session that is still open.

export interface LeaveSaves {
  /** a field's save at a leave, for as long as the field is on screen; returns the way to stop */
  add(save: () => void): () => void;
  /** the leave, before the lock: every field's save is asked for now */
  run(): void;
}

export function leaveSaves(): LeaveSaves {
  const saves = new Set<() => void>();
  return {
    add(save) {
      saves.add(save);
      return () => { saves.delete(save); };
    },
    run() {
      for (const save of [...saves]) {
        try {
          save();
        } catch {
          // one field that fails to save never stops the others, or the lock
        }
      }
    },
  };
}
