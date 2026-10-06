// The words in one of Today's fields, between the typing and the record. The field can go away while
// it still holds unsaved words (the 14:00 switch, the new day at the boundary), and React never
// calls a removed field's blur, so the draft is kept here and saved when the field goes.

export interface Draft {
  /** the words as they stand in the field */
  type(text: string): void;
  /** sends the words, unless the record holds them already or they are on their way */
  flush(): void;
  /** the field is on screen (again) */
  open(): void;
  /** the field went away: a last flush, and words that then fail to save go to `lost` */
  close(): void;
}

/**
 * `saved` is what the record holds; `typed` what the field starts with (a draft kept from before).
 * A save that fails is tried again on the next flush; once the field has gone, it is handed to
 * `lost` with the words, so they never vanish without a word.
 */
export function draft(saved: string, save: (text: string) => Promise<boolean>, lost: (text: string) => void, typed = saved): Draft {
  let text = typed;
  // what the record holds, or is being sent
  let kept = saved;
  let closed = false;
  const flush = () => {
    const value = text;
    if (value === kept) return;
    const before = kept;
    kept = value;
    const failed = () => {
      if (kept !== value) return;   // newer words are on their way, and carry this
      kept = before;
      if (closed) lost(value);
    };
    save(value).then(ok => { if (!ok) failed(); }, failed);
  };
  return {
    type(next) { text = next; },
    flush,
    open() { closed = false; },
    close() {
      closed = true;
      flush();
    },
  };
}
