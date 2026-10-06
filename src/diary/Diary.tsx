import { useEffect, useRef, useState } from 'react';
import { resultWords, useApp, useClockMinute, useHeld, useModel, useNav, useToday } from '../app/context.ts';
import type { RecordCore } from '../record/core.ts';
import type { Result } from '../record/results.ts';
import { restoreEntry, saveEntry, trashEntry } from '../record/ops/words.ts';
import { I } from '../ui/icons.tsx';
import { DIARY_WORDS, dayLabel, dayOf, firstLine, freshStill, inTrash, longDate, pages, todaysPage, writtenAt } from './diaryView.ts';

// The diary: today's page, and the pages before it, newest first. A page is saved when you leave
// it, and kept as typed until the save is confirmed: words whose save didn't go through are held
// for the visit and come back on their page. Moving a page to the trash is the one place the app
// uses red, and it can be undone for seven days.

const hm = (m: number) => `${String(Math.floor(m / 60) % 24).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
const timeOf = (ms: number, tz: string) => new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(ms);
// held words go by page; a new page's, not yet in the record, under one name that outlasts the screen
const heldKey = (id: string, written: boolean) => (written ? `diary:${id}` : 'diary:new');

export function Diary() {
  const { core, store } = useApp();
  const { go } = useNav();
  const held = useHeld();
  const model = useModel();
  const today = useToday();
  const t = useClockMinute();
  const [openId, setOpenId] = useState<string | undefined>(undefined);
  // the new page's id, made for one day, so saving twice makes one page (freshStill says when it's done)
  const [fresh, setFresh] = useState(() => ({ id: core.newId(), made: today }));
  const [asking, setAsking] = useState(false);
  const [earlier, setEarlier] = useState(false);              // a phone shows the index in place, on request
  const [note, setNote] = useState<{ readonly title: string; readonly text: string } | undefined>(undefined);
  const sending = useRef(new Map<string, string>());          // words on their way, by page, so a blur and the field going send them once
  if (!model || !today) return null;
  if (!freshStill(model, fresh, today)) {
    setFresh({ id: core.newId(), made: today });
    if (openId === fresh.id) setOpenId(undefined);
  }
  const tz = model.settings.tz;
  const todays = todaysPage(model, today);
  const id = openId ?? todays?.id ?? fresh.id;
  const shown = model.entries.get(id);
  const kept = held.get(heldKey(id, shown !== undefined));
  const heldNew = held.get(heldKey(fresh.id, false));

  const run = async (write: (c: RecordCore) => Promise<Result<void>>) => {
    const result = await store.run(write);
    setNote(resultWords(result));
    return result.kind === 'Saved';
  };
  // a page's words go to that page, even when it is no longer the one on screen
  const save = (page: string, body: string | undefined, text: string) => {
    const key = heldKey(page, body !== undefined);
    if (text === (body ?? '') || (body === undefined && !text.trim())) { held.drop(key); return; }
    if (sending.current.get(page) === text) return;
    sending.current.set(page, text);
    void held.keep(key, text, () => store.run(c => saveEntry(c, { id: page, body: text }))).finally(() => {
      if (sending.current.get(page) === text) sending.current.delete(page);
    });
  };

  // the words for this page's own save that didn't go through, or for the last trash or put back
  const said = kept?.note ?? note;
  const list = pages(model);
  const trashed = inTrash(model.entries.values());
  const indexBody = (
    <>
      <div style={{ marginTop: 14 }}>
        {(!todays || heldNew) && (
          <button type="button" data-a="new-page" className={`li${id === fresh.id ? ' on' : ''}`} style={{ borderRadius: 12, boxShadow: 'none', gridTemplateColumns: 'minmax(0,1fr)' }} onClick={() => { setOpenId(todays ? fresh.id : undefined); setAsking(false); setEarlier(false); }}>
            <span style={{ minWidth: 0 }}><span className="nm">Today <span className="meta" style={{ marginLeft: 6 }}>{heldNew ? DIARY_WORDS.notSaved : hm(t)}</span></span>
              <span className="sub serif" style={{ fontSize: 15, color: 'var(--ink-4)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{heldNew ? firstLine(heldNew.text) : 'A new page'}</span></span>
          </button>
        )}
        {list.map(e => {
          const at = writtenAt(e.id);
          return (
            <button key={e.id} type="button" data-a="page" className={`li${id === e.id ? ' on' : ''}`} style={{ borderRadius: 12, boxShadow: 'none', gridTemplateColumns: 'minmax(0,1fr)' }} onClick={() => { setOpenId(e.id); setAsking(false); setEarlier(false); }}>
              <span style={{ minWidth: 0 }}>
                <span className="nm">{dayLabel(e.date, today)}{at !== undefined && <span className="meta" style={{ marginLeft: 6 }}>{timeOf(at, tz)}</span>}{held.get(heldKey(e.id, true)) && <span className="meta" style={{ marginLeft: 6 }}>{DIARY_WORDS.notSaved}</span>}</span>
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
          <PageField key={id} text={kept?.text ?? shown?.body ?? ''} save={text => save(id, shown?.body, text)} />
          {said && <div className="panel note" data-a="page-note" style={{ marginTop: 16 }}><p className="eb">{said.title}</p><p className="body" style={{ margin: '8px 0 0' }}>{said.text}</p></div>}
        </div>
      </main>
    </div>
  );
}

/**
 * The page being written. It belongs to one page (its key is the page's id), and words still in it
 * when it goes away (another page opened, the day moving on) are saved to that page: React never
 * calls a removed field's blur.
 */
function PageField(p: { readonly text: string; save(text: string): void }) {
  const field = useRef<HTMLDivElement>(null);
  const latest = useRef(p);
  latest.current = p;
  const typed = useRef<string | undefined>(undefined);       // what is in the field, once anything was typed in it
  useEffect(() => {
    if (field.current && document.activeElement !== field.current) field.current.innerText = p.text;
  }, [p.text]);
  useEffect(() => () => { if (typed.current !== undefined) latest.current.save(typed.current); }, []);
  const read = () => (typed.current = field.current?.innerText.replace(/\n+$/, '') ?? '');
  return (
    <div ref={field} className="page" contentEditable suppressContentEditableWarning spellCheck data-ph="Today was…" data-a="page-text"
      role="textbox" aria-multiline="true" aria-label="Diary page" onInput={read} onBlur={() => p.save(read())} />
  );
}
