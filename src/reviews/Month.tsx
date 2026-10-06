import { useMemo, useRef, useState } from 'react';
import { resultWords, useApp, useHeld, useModel, useNav, useToday } from '../app/context.ts';
import { settleHabit } from '../record/ops/habits.ts';
import { saveReview } from '../record/ops/reviews.ts';
import { rulesInput } from '../record/read.ts';
import { datesFrom } from '../rules/dates.ts';
import { lookup, stateOf } from '../rules/state.ts';
import { Answer } from './Answer.tsx';
import { monthView } from './reviewView.ts';

// The monthly review, from day 60: the month in words, what seemed to go well together (only good
// pairings, only with eight days on each side, never as a cause), and the offer to stop asking
// about a habit that has been steady for eight weeks. A line whose save didn't go through is held for
// the visit and comes back in its field, and goes with "That's the month", as do the words in the
// field when it is tapped.

const MON3 = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const short = (date: string) => { const d = new Date(`${date}T00:00:00Z`); return `${d.getUTCDate()} ${MON3[d.getUTCMonth()]}`; };
const CLS: Record<string, string> = { did: 'd', partly: 'p', planned: 'pl', nothing: '', off: 'off', outside: 'na' };

export function Month() {
  const { store } = useApp();
  const { go } = useNav();
  const held = useHeld();
  const model = useModel();
  const today = useToday();
  const [settled, setSettled] = useState<'yes' | 'no' | undefined>(undefined);
  const [note, setNote] = useState<{ readonly title: string; readonly text: string } | undefined>(undefined);
  const typed = useRef(new Map<string, string>());   // what is in each field now, by its held key
  const revision = store.revision();
  const input = useMemo(() => (model ? rulesInput(model) : undefined), [model, revision]);
  if (!model || !today || !input) return null;
  const v = monthView(input, model, today);

  if (!v.open) {
    const left = Math.round((Date.parse(v.opensOn) - Date.parse(today)) / 86_400_000);
    return (
      <div className="scr"><main className="col" style={{ maxWidth: 520, margin: '0 auto', width: '100%' }}>
        <div className="gate" style={{ minHeight: '60dvh' }}>
          <p className="eb">Monthly review</p><h1 className="t-l" style={{ marginTop: 8 }}>Opens on day 60</h1>
          <p className="body" style={{ margin: '12px 0 0' }}>{short(v.opensOn)} — in {left} days. A month in words needs at least one whole month, and what seems to go well together needs at least eight days of each side.</p>
        </div>
      </main></div>
    );
  }

  const saved = model.reviews.get(`m:${v.first.slice(0, 7)}`);
  const save = async (answers: Record<string, string>, close = false) => {
    const result = await store.run(c => saveReview(c, { period: 'month', start: v.first, answers, close }));
    setNote(resultWords(result));
    return result.kind === 'Saved';
  };
  const heldKey = `month:${v.first}:line`;
  const kept = held.get(heldKey);
  // the line goes in on leaving its field; one that isn't the record's any more is held, not lost
  const answer = (text: string) => {
    if (text === (saved?.answers.line ?? '')) { held.drop(heldKey); return; }
    void held.keep(heldKey, text, () => store.run(c => saveReview(c, { period: 'month', start: v.first, answers: { line: text }, close: false })));
  };
  const days = datesFrom(v.from, v.to);
  const settle = v.settle;
  const settlePanel = settled === 'yes' && settle === undefined
    ? <div className="panel"><p className="eb">Settled</p><p className="body" style={{ margin: '10px 0 0' }}>It moves to Log tomorrow. A Focus slot is free.</p></div>
    : settle && settled === undefined
      ? (
        <div className="panel"><p className="eb">Settled?</p>
          <p className="t-m" style={{ margin: '10px 0 6px', fontWeight: 450 }}>{settle.name} has been steady for eight weeks.</p>
          <p className="body" style={{ margin: '0 0 14px' }}>Want to stop being asked about it? It moves to Log and keeps every day it was logged. That also frees a Focus slot.</p>
          <div className="two">
            <button type="button" className="btn btn--secondary" data-a="settle" data-x="yes" onClick={async () => {
              const result = await store.run(c => settleHabit(c, { id: settle.id }));
              setNote(resultWords(result));
              if (result.kind === 'Saved') setSettled('yes');
            }}>Settle it</button>
            <button type="button" className="btn btn--secondary" data-a="settle" data-x="no" onClick={() => setSettled('no')}>Keep asking</button>
          </div>
        </div>
      ) : null;
  const line = (
    <div className="group" style={{ marginTop: 0 }}><label className="eb field-l" htmlFor="mo-line">One line for {v.name}, in your own words</label>
      <Answer id="mo-line" key={v.first} rows={3} placeholder={`${v.name} was…`} saved={saved?.answers.line ?? ''} held={kept?.text} onLeave={answer}
        onType={text => typed.current.set(heldKey, text)} />
      {kept && <div className="panel note" data-a="held-note" style={{ marginTop: 10 }}><p className="eb">{kept.note.title}</p><p className="body" style={{ margin: '8px 0 0' }}>{kept.note.text}</p></div>}</div>
  );
  const notePanel = note && <div className="panel note"><p className="eb">{note.title}</p><p className="body" style={{ margin: '8px 0 0' }}>{note.text}</p></div>;
  // the close takes the line itself: its field's blur may not have saved yet, or at all
  const finish = <button type="button" className="btn btn--primary wide" data-a="month-done" onClick={async () => {
    const text = typed.current.get(heldKey) ?? kept?.text;
    if (!await save(text === undefined ? {} : { line: text }, true)) return;
    held.drop(heldKey);
    go('look');
  }}>That's the month</button>;

  return (
    <div className="scr scr-2">
      <main className="col">
        <div className="stack-l">
          <div><p className="eb">Monthly review · day {Math.round((Date.parse(today) - Date.parse(model.settings.journeyStart)) / 86_400_000) + 1}</p>
            <h1 className="t-l" style={{ marginTop: 6 }}>{v.name}, in words</h1>
            <p className="meta" style={{ margin: '4px 0 0' }}>{short(v.from)} – {short(v.to)} · no numbers, no scores</p></div>
          <div className="panel panel--hero"><p className="eb" style={{ marginBottom: 16 }}>The month</p>
            {v.rows.map(r => (
              <div key={r.habit.id} className="mo-row">
                <div><div className="t-m" style={{ fontSize: 15, fontWeight: 450 }}>{r.habit.name}</div><div className="band"><b>{r.words}</b></div></div>
                <div className="cells">{days.map(date => <i key={date} className={`c ${CLS[stateOf(r.habit, lookup(input.index, r.habit.id, date), date)]}`} />)}</div>
              </div>
            ))}
          </div>
          <div className="panel"><p className="eb">What seems to go well together</p>
            {v.together.length
              ? <div className="helps">{v.together.map(s => <p key={s}>{s}</p>)}</div>
              : <p className="body" style={{ margin: '12px 0 0' }}>Nothing clear yet — which is a normal answer after one month.</p>}
            <p className="meta" style={{ margin: '14px 0 0' }}>Only things that went well together are shown, and only with at least eight days of each. It's a pattern, not proof that one caused the other.</p>
          </div>
          <div className="phone-only stack-l">{settlePanel}{line}{notePanel}{finish}</div>
        </div>
      </main>
      <aside className="col side wide-only"><div className="stack-l">{settlePanel}{line}{notePanel}{finish}</div></aside>
    </div>
  );
}
