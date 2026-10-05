import { useRef, useState } from 'react';
import { resultWords, useApp, useModel, useNav } from '../app/context.ts';
import { restoreNotYet, saveNotYet, trashNotYet } from '../record/ops/words.ts';
import { I } from '../ui/icons.tsx';
import { DIARY_WORDS, dayOf, inTrash, writtenAt } from './diaryView.ts';

// Not yet: things being thought about. Nothing here is tracked, counted, scheduled or brought up.

export function NotYet() {
  const { core, store } = useApp();
  const { go } = useNav();
  const model = useModel();
  const [adding, setAdding] = useState(false);
  const [newId, setNewId] = useState(() => core.newId());
  const [note, setNote] = useState<{ readonly title: string; readonly text: string } | undefined>(undefined);
  const field = useRef<HTMLInputElement>(null);
  if (!model) return null;
  const tz = model.settings.tz;
  const items = [...model.notyet.values()].filter(n => n.trashedAt === undefined).sort((a, b) => (a.id < b.id ? -1 : 1));
  const trashed = inTrash(model.notyet.values());
  const run = async (write: Parameters<typeof store.run>[0]) => {
    const result = await store.run(write);
    setNote(resultWords(result));
    return result.kind === 'Saved';
  };
  const add = async () => {
    const text = field.current?.value.trim() ?? '';
    if (!text) { setAdding(false); return; }
    if (await run(c => saveNotYet(c, { id: newId, text }))) {
      if (field.current) field.current.value = '';
      setNewId(core.newId());
      setAdding(false);
    }
  };
  return (
    <div className="ny">
      <button type="button" className="btn btn--text" data-a="nav" data-x="diary" style={{ paddingLeft: 0, gap: 4 }} onClick={() => go('diary')}>{I.back({ width: 18, height: 18 })}Diary</button>
      <p className="eb" style={{ marginTop: 18 }}>Not yet</p>
      <p className="meta" style={{ margin: '8px 0 20px' }}>{DIARY_WORDS.notYetIntro}</p>
      {items.map(n => {
        const at = writtenAt(n.id);
        return (
          <div key={n.id} className="ny-item" data-a="ny-item">
            <div className="serif">{n.text}</div>
            <small>{at !== undefined ? `written ${dayOf(at, tz)} · ` : ''}<button type="button" className="btn btn--text" data-a="ny-away" style={{ padding: 0, minHeight: 0, fontSize: 13 }} onClick={() => void run(c => trashNotYet(c, { id: n.id }))}>put it away</button></small>
          </div>
        );
      })}
      {adding
        ? <form onSubmit={e => { e.preventDefault(); void add(); }} style={{ marginTop: 14 }}>
            <input ref={field} className="pass" data-a="ny-text" aria-label="Something you're thinking about" placeholder="Something you're thinking about" autoFocus onBlur={() => void add()} />
          </form>
        : <button type="button" className="btn btn--text" data-a="ny-add" style={{ paddingLeft: 0, marginTop: 14, gap: 6 }} onClick={() => setAdding(true)}>{I.plus()}Write something down</button>}
      {trashed.length > 0 && (
        <>
          <p className="eb" style={{ margin: '26px 0 8px' }}>Put away</p>
          {trashed.map(({ item, goneAt }) => (
            <div key={item.id} className="ny-item" data-a="ny-trashed">
              <div className="serif" style={{ color: 'var(--ink-4)' }}>{item.text}</div>
              <small>gone on {dayOf(goneAt, tz)} · <button type="button" className="btn btn--text" data-a="ny-back" style={{ padding: 0, minHeight: 0, fontSize: 13 }} onClick={() => void run(c => restoreNotYet(c, { id: item.id }))}>bring it back</button></small>
            </div>
          ))}
        </>
      )}
      {note && <div className="panel note" style={{ marginTop: 16 }}><p className="eb">{note.title}</p><p className="body" style={{ margin: '8px 0 0' }}>{note.text}</p></div>}
    </div>
  );
}
