import { useMemo, useRef, useState, type CSSProperties } from 'react';
import { resultWords, useApp, useHeld, useModel, useNav, useToday } from '../app/context.ts';
import { saveReview } from '../record/ops/reviews.ts';
import { rulesInput } from '../record/read.ts';
import { datesFrom } from '../rules/dates.ts';
import { lookup, stateOf } from '../rules/state.ts';
import { Answer } from './Answer.tsx';
import { weekView, type WeekRow } from './reviewView.ts';

// The Sunday review: the week in words. Its two questions are optional; the week counts whether or
// not anything is written. An answer whose save didn't go through is held for the visit and comes
// back in its field, and goes with "That's the week", as do the words in the fields when it is tapped.

const LETTERS = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];
const DOW = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MON = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const MON3 = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const d = (date: string) => new Date(`${date}T00:00:00Z`);
const short = (date: string) => `${d(date).getUTCDate()} ${MON3[d(date).getUTCMonth()]}`;
const CLS: Record<string, string> = { did: 'd', partly: 'p', planned: 'pl', nothing: '', off: 'off', outside: 'na' };
const vars = (v: Record<string, string>) => v as CSSProperties;
const QUESTIONS = ['changed', 'line'] as const;

export function Week() {
  const { store } = useApp();
  const { go } = useNav();
  const held = useHeld();
  const model = useModel();
  const today = useToday();
  const [step, setStep] = useState(0);
  const [note, setNote] = useState<{ readonly title: string; readonly text: string } | undefined>(undefined);
  const typed = useRef(new Map<string, string>());   // what is in each field now, by its held key
  const revision = store.revision();
  const input = useMemo(() => (model ? rulesInput(model) : undefined), [model, revision]);
  if (!model || !today || !input) return null;
  const v = weekView(input, model, today);
  const saved = model.reviews.get(`w:${v.monday}`);
  const days = datesFrom(v.monday, v.sunday);

  const save = async (answers: Record<string, string>, close = false) => {
    const result = await store.run(c => saveReview(c, { period: 'week', start: v.monday, answers, close }));
    setNote(resultWords(result));
    return result.kind === 'Saved';
  };
  const heldKey = (q: string) => `week:${v.monday}:${q}`;
  // an answer goes in on leaving its field; one that isn't the record's any more is held, not lost
  const answer = (q: (typeof QUESTIONS)[number], text: string) => {
    if (text === (saved?.answers[q] ?? '')) { held.drop(heldKey(q)); return; }
    void held.keep(heldKey(q), text, () => store.run(c => saveReview(c, { period: 'week', start: v.monday, answers: { [q]: text }, close: false })));
  };
  // the close takes the answers themselves: a field's blur may not have saved yet, or at all
  const done = async () => {
    const kept = QUESTIONS.flatMap(q => { const h = held.get(heldKey(q)); return h ? [[q, h.text] as const] : []; });
    const now = QUESTIONS.flatMap(q => { const t = typed.current.get(heldKey(q)); return t === undefined ? [] : [[q, t] as const]; });
    if (!await save(Object.fromEntries([...kept, ...now]), true)) return;
    for (const [q] of kept) held.drop(heldKey(q));
    go('look');
  };
  const heldNote = (q: string) => {
    const h = held.get(heldKey(q));
    return h && <div className="panel note" data-a="held-note" style={{ marginTop: 10 }}><p className="eb">{h.note.title}</p><p className="body" style={{ margin: '8px 0 0' }}>{h.note.text}</p></div>;
  };

  const letters = <div className="axis" style={vars({ '--cs': 'var(--wcs)', '--cg': '6px' })}>{LETTERS.map((x, i) => <span key={i}>{x}</span>)}</div>;
  const head = <><div className="wk-head"><div />{letters}</div><div className="phone-only" style={{ marginBottom: 10 }}>{letters}</div></>;
  const grid = (rows: readonly WeekRow[], scored: boolean) => rows.map(r => (
    <div key={r.habit.id} className="wk-row">
      <div>
        <div className="t-m" style={{ fontSize: 15, fontWeight: 450 }}>{r.habit.name}</div>
        <div className="band" style={{ marginTop: 3 }}>{r.words ? <b>{r.words}</b> : v.empty ? 'the week hasn’t happened yet' : 'a quiet week'}
          {r.momentum && scored && <span className="mw" style={{ marginLeft: 6 }}>{r.momentum}</span>}</div>
      </div>
      <div className={`cells wk${scored ? '' : ' logc'}`} style={vars({ '--cs': 'var(--wcs)' })}>
        {days.map(date => <i key={date} className={`c ${v.empty || date > today ? '' : CLS[stateOf(r.habit, lookup(input.index, r.habit.id, date), date)]}`} />)}
      </div>
    </div>
  ));
  const sunday = d(v.sunday);
  const title = (
    <>
      <p className="eb">{DOW[sunday.getUTCDay()]} {sunday.getUTCDate()} {MON[sunday.getUTCMonth()]} · week {v.weekNumber}</p>
      <h1 className="t-l" style={{ marginTop: 8 }}>The week</h1>
      <p className="meta" style={{ margin: '4px 0 0' }}>{short(v.monday)} – {short(v.sunday)} · described in words, never numbers</p>
    </>
  );
  const prompts = (
    <>
      <div className="group" style={{ marginTop: 0 }}><label className="eb field-l" htmlFor="wk-changed">What changed that isn't in the data?</label>
        <Answer id="wk-changed" key={`c${v.monday}`} rows={3} placeholder="This week…" saved={saved?.answers.changed ?? ''} held={held.get(heldKey('changed'))?.text}
          onLeave={text => answer('changed', text)} onType={text => typed.current.set(heldKey('changed'), text)} />{heldNote('changed')}</div>
      <div className="group"><label className="eb field-l" htmlFor="wk-line">One line for the week, in your own words</label>
        <Answer id="wk-line" key={`l${v.monday}`} rows={2} placeholder="The week was…" saved={saved?.answers.line ?? ''} held={held.get(heldKey('line'))?.text}
          onLeave={text => answer('line', text)} onType={text => typed.current.set(heldKey('line'), text)} />{heldNote('line')}</div>
    </>
  );
  const how = (
    <details className="meta" style={{ margin: '14px 4px 0' }}>
      <summary style={{ cursor: 'pointer', color: 'var(--ink-2)' }}>How are the words worked out?</summary>
      <p style={{ margin: '8px 0 0' }}>Most days: at least 7 in 10 of the days it was asked. About half: 4 in 10 or more. Building: two or more days more than the week before. Dipped: two or more fewer. Steady: anything in between. Strong: five days or more, holding.</p>
    </details>
  );
  const adjust = (
    <div className="panel"><p className="eb">One thing to add or adjust</p><p className="body" style={{ margin: '10px 0 14px' }}>This is where new things arrive — quietly, on a Sunday, instead of on a Tuesday morning.</p>
      <button type="button" className="btn btn--ghost" data-a="nav" data-x="plan" onClick={() => go('plan')}>Open Plan</button></div>
  );
  const notePanel = note && <div className="panel note"><p className="eb">{note.title}</p><p className="body" style={{ margin: '8px 0 0' }}>{note.text}</p></div>;

  const phone = step === 0
    ? <>
        <div className="panel" style={vars({ '--wcs': '36px' })}>{title}<div style={{ marginTop: 22 }}>{head}{grid(v.focus, true)}</div>{how}</div>
        {v.log.length > 0 && <div className="panel" style={vars({ '--wcs': '36px' })}><p className="eb" style={{ marginBottom: 14 }}>Also recorded · never scored</p>{grid(v.log, false)}</div>}
      </>
    : step === 1
      ? <div className="panel">{prompts}<p className="meta" style={{ margin: '12px 4px 0' }}>Both are optional. The week counts whether or not you write.</p></div>
      : adjust;

  return (
    <div className="scr" style={{ gridTemplateColumns: 'minmax(0,1fr) 440px' }}>
      <main className="col">
        <div className="phone-only stack">
          {phone}
          {notePanel}
          <div className="pager">
            <div className="dots">{[0, 1, 2].map(i => <i key={i} className={i === step ? 'on' : ''} />)}</div>
            {step < 2
              ? <button type="button" className="btn btn--secondary" data-a="wstep" data-x={step + 1} onClick={() => { setStep(step + 1); window.scrollTo(0, 0); }}>Next</button>
              : <button type="button" className="btn btn--primary" data-a="week-done" onClick={() => void done()}>That's the week</button>}
          </div>
        </div>
        <div className="wide-only">
          <div className="stack-l">
            <div className="panel panel--hero" style={vars({ '--wcs': '34px', padding: '24px 26px' })}>
              {title}
              <div style={{ marginTop: 24 }}>{head}</div>
              <div style={{ marginTop: 10 }}>{grid(v.focus, true)}</div>
              {v.log.length > 0 && <><hr className="rule" style={{ margin: '22px 0' }} /><p className="eb" style={{ marginBottom: 14 }}>Also recorded · never scored</p>{grid(v.log, false)}</>}
              {how}
            </div>
          </div>
        </div>
      </main>
      <aside className="col side wide-only">
        <div className="stack-l">{prompts}{adjust}{notePanel}<button type="button" className="btn btn--primary wide" data-a="week-done" onClick={() => void done()}>That's the week</button></div>
      </aside>
    </div>
  );
}
