import { useEffect, useRef, useState } from 'react';
import { resultWords, useApp, useClockMinute, useModel, useNav, useToday } from '../app/context.ts';
import type { RecordCore } from '../record/core.ts';
import type { Result } from '../record/results.ts';
import { restoreEntry, saveEntry, trashEntry } from '../record/ops/words.ts';
import { I } from '../ui/icons.tsx';
import { DIARY_WORDS, dayLabel, dayOf, firstLine, inTrash, longDate, pages, todaysPage, writtenAt } from './diaryView.ts';

// The diary: today's page, and the pages before it, newest first. A page is saved when you leave
// it, and kept as typed until the save is confirmed. Moving a page to the trash is the one place
// the app uses red, and it can be undone for seven days.

const hm = (m: number) => `${String(Math.floor(m / 60) % 24).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
const timeOf = (ms: number, tz: string) => new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(ms);

export function Diary() {
  const { core, store } = useApp();
  const { go } = useNav();
  const model = useModel();
  const today = useToday();
  const t = useClockMinute();
  const [openId, setOpenId] = useState<string | undefined>(undefined);
  const [freshId] = useState(() => core.newId());           // made when the page opens, so saving twice makes one page
  const [asking, setAsking] = useState(false);
  const [earlier, setEarlier] = useState(false);              // a phone shows the index in place, on request
  const [note, setNote] = useState<{ readonly title: string; readonly text: string } | undefined>(undefined);
  const field = useRef<HTMLDivElement>(null);
  const shown = model && today ? (openId ? model.entries.get(openId) : todaysPage(model, today)) : undefined;
  const id = shown?.id ?? freshId;
  const body = shown?.body ?? '';
  useEffect(() => {
    if (field.current && document.activeElement !== field.current) field.current.innerText = body;
  }, [id, body]);
  if (!model || !today) return null;
  const tz = model.settings.tz;

  const run = async (write: (c: RecordCore) => Promise<Result<void>>) => {
    const result = await store.run(write);
    setNote(resultWords(result));
    return result.kind === 'Saved';
  };
  const save = () => {
    const text = field.current?.innerText.replace(/\n+$/, '') ?? '';
    if (text === body || (!shown && !text.trim())) return;
    void run(c => saveEntry(c, { id, body: text }));
  };

  const list = pages(model);
  const trashed = inTrash(model.entries.values());
  const indexBody = (
    <>
      <div style={{ marginTop: 14 }}>
        {!todaysPage(model, today) && (
          <button type="button" className={`li${!openId ? ' on' : ''}`} style={{ borderRadius: 12, boxShadow: 'none', gridTemplateColumns: 'minmax(0,1fr)' }} onClick={() => setOpenId(undefined)}>
            <span style={{ minWidth: 0 }}><span className="nm">Today <span className="meta" style={{ marginLeft: 6 }}>{hm(t)}</span></span><span className="sub serif" style={{ fontSize: 15, color: 'var(--ink-4)' }}>A new page</span></span>
          </button>
        )}
        {list.map(e => {
          const at = writtenAt(e.id);
          return (
            <button key={e.id} type="button" data-a="page" className={`li${shown?.id === e.id ? ' on' : ''}`} style={{ borderRadius: 12, boxShadow: 'none', gridTemplateColumns: 'minmax(0,1fr)' }} onClick={() => { save(); setOpenId(e.id); setAsking(false); setEarlier(false); }}>
              <span style={{ minWidth: 0 }}>
                <span className="nm">{dayLabel(e.date, today)}{at !== undefined && <span className="meta" style={{ marginLeft: 6 }}>{timeOf(at, tz)}</span>}</span>
                <span className="sub serif" style={{ fontSize: 15, color: 'var(--ink-3)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{firstLine(e.body)}</span>
              </span>
            </button>
          );
        })}
      </div>
      {trashed.length > 0 && (
        <>
          <hr className="rule" style={{ margin: '14px 0' }} />
          <p className="eb" style={{ margin: '0 4px 8px' }}>In the trash</p>
          {trashed.map(({ item, goneAt }) => (
            <div key={item.id} className="li" data-a="trashed" style={{ borderRadius: 12, boxShadow: 'none' }}>
              <span><span className="nm">{dayLabel(item.date, today)}</span><span className="sub">its words go on {dayOf(goneAt, tz)}</span></span>
              <button type="button" className="btn btn--text" data-a="putback" onClick={() => void run(c => restoreEntry(c, { id: item.id }))}>Put back</button>
            </div>
          ))}
        </>
      )}
      <hr className="rule" style={{ margin: '14px 0' }} />
      <button type="button" className="li" data-a="nav" data-x="notyet" style={{ borderRadius: 12, boxShadow: 'none' }} onClick={() => go('notyet')}>
        <span><span className="nm">Not yet</span><span className="sub">Things you're thinking about</span></span><span className="end">{I.chev()}</span>
      </button>
    </>
  );
  const index = (
    <aside className="col index">
      <div className="between" style={{ marginBottom: 14 }}><span className="eb">Diary</span><span className="meta">newest first</span></div>
      {indexBody}
    </aside>
  );

  return (
    <div className="scr scr-2l">
      {index}
      <main className="col">
        <div className="diary">
          <div className="top">
            <span className="meta">{longDate(shown?.date ?? today)}{!shown || shown.date === today ? ` · ${hm(t)}` : ''}</span>
            <span style={{ display: 'flex', gap: 2 }}>
              <button type="button" className="btn btn--text phone-only" data-a="nav" data-x="notyet" onClick={() => go('notyet')}>Not yet</button>
              <button type="button" className="btn btn--text phone-only" data-a="earlier" onClick={() => setEarlier(!earlier)}>{earlier ? 'Close' : 'Earlier'}</button>
              {shown && <button type="button" className="btn btn--text" data-a="trash" onClick={() => setAsking(true)}>Trash</button>}
            </span>
          </div>
          {asking && shown && (
            <div className="panel note" data-a="trash-ask" style={{ marginBottom: 16 }}>
              <p className="eb">{DIARY_WORDS.trashAsk}</p>
              <p className="body" style={{ margin: '8px 0 14px' }}>{DIARY_WORDS.trashSay}</p>
              <div className="two">
                <button type="button" className="btn btn--secondary" data-a="trash-no" onClick={() => setAsking(false)}>{DIARY_WORDS.trashNo}</button>
                <button type="button" className="btn btn--delete" data-a="trash-yes" onClick={async () => {
                  if (await run(c => trashEntry(c, { id: shown.id }))) { setAsking(false); setOpenId(undefined); setEarlier(true); }
                }}>{DIARY_WORDS.trashYes}</button>
              </div>
            </div>
          )}
          {earlier && <div className="phone-only" data-a="earlier-list" style={{ marginBottom: 18 }}>{indexBody}</div>}
          <div key={id} ref={field} className="page" contentEditable suppressContentEditableWarning spellCheck data-ph="Today was…" data-a="page-text"
            role="textbox" aria-multiline="true" aria-label="Diary page" onBlur={save} />
          {note && <div className="panel note" style={{ marginTop: 16 }}><p className="eb">{note.title}</p><p className="body" style={{ margin: '8px 0 0' }}>{note.text}</p></div>}
        </div>
      </main>
    </div>
  );
}
