import { useEffect, useRef } from 'react';
import { useSaveAtLeave } from '../app/context.ts';

// One of a review's own-words fields. It starts with what the record holds, or with words held from
// a save that didn't go through; words held after it is back on screen (the answer can come after
// the screen did) are put in too, unless it is being written in. Words in it when the app is left
// are saved before the lock, and each change is told, so a close can take what is in it.

export function Answer(p: {
  readonly id: string;
  readonly rows: number;
  readonly placeholder: string;
  readonly saved: string;
  readonly held?: string;
  onLeave(text: string): void;
  onType(text: string): void;
}) {
  const field = useRef<HTMLTextAreaElement>(null);
  useSaveAtLeave(field, () => { if (field.current) p.onLeave(field.current.value); });
  useEffect(() => {
    if (p.held !== undefined && field.current && document.activeElement !== field.current) field.current.value = p.held;
  }, [p.held]);
  return (
    <textarea ref={field} id={p.id} className="field" rows={p.rows} placeholder={p.placeholder} defaultValue={p.held ?? p.saved}
      onInput={e => p.onType(e.currentTarget.value)} onBlur={e => p.onLeave(e.currentTarget.value)} />
  );
}
