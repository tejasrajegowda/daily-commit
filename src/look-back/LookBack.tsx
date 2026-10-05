import { useMemo, useState, type CSSProperties } from 'react';
import { monthDue, useApp, useModel, useNav, useToday } from '../app/context.ts';
import { rulesInput } from '../record/read.ts';
import { dayNumber, hasOpened } from '../rules/journey.ts';
import { countWord } from '../rules/words.ts';
import { I } from '../ui/icons.tsx';
import { useWide } from '../ui/useWide.ts';
import { axisLetters, cells, countUnit, longDay, monthsField, numbersOf, opensLater, sentence, tiers, trend, unitLine, valueWords, weekSpans, window, type Cell, type Words } from './lookView.ts';
import { Trend } from './Trend.tsx';

// Look back: what happened, in evidence, never in scores. On a phone, a card per habit in Focus;
// on a laptop, the evidence rows, with a click on any column showing that day.

const vars = (v: Record<string, string>) => v as CSSProperties;
const DOW = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function Cells({ list, style, cls = 'cells', onPick, picked }: { readonly list: readonly Cell[]; readonly style: CSSProperties; readonly cls?: string; onPick?(date: string): void; readonly picked?: string }) {
  return (
    <div className={cls} style={style}>
      {list.map((c, i) => (
        <i key={c.date} className={`c ${c.cls}${c.now ? ' now' : ''}${picked === c.date ? ' sel' : ''}`} title={c.title}
          data-a={onPick && !c.future ? 'sel' : undefined} data-x={onPick && !c.future ? String(i) : undefined}
          onClick={onPick && !c.future ? () => onPick(c.date) : undefined} />
      ))}
    </div>
  );
}

export function Said({ words }: { readonly words: Words }) {
  return <p>{words.map((w, i) => (w.bold ? <b key={i}>{w.text}</b> : <span key={i}>{w.text}</span>))}</p>;
}

const LEGEND = <div className="legend"><span><i className="d" />did it</span><span><i className="p" />partly</span><span><i className="pl" />planned rest</span><span><i />nothing recorded</span></div>;

export function LookBack() {
  const { store } = useApp();
  const { go } = useNav();
  const model = useModel();
  const today = useToday();
  const wide = useWide();
  const [picked, setPicked] = useState<string | undefined>(undefined);
  const revision = store.revision();
  const input = useMemo(() => (model ? rulesInput(model) : undefined), [model, revision]);
  if (!model || !today || !input) return null;

  const start = model.settings.journeyStart;
  const day = dayNumber(start, today);
  const { focus, log } = tiers(input, today);
  const win = window(start, today);
  const pitch = Math.floor(560 / win.span), cg = pitch >= 24 ? 6 : 4, cs = Math.max(12, Math.min(28, pitch - cg)), cr = cs >= 20 ? 6 : 3;
  const cellVars = vars({ '--cs': `${cs}px`, '--cg': `${cg}px`, '--cr': `${cr}px` });
  const said = sentence(input, model, today);
  const wake = focus.find(h => h.kind === 'time') ?? input.habits.find(h => h.kind === 'time');

  // the phone's cards show the last two weeks
  const cardFrom = datesBack(today, Math.min(day, 14));

  const later = opensLater(day);
  const laterPanel = later.length > 0 && (
    <div className="later">
      <p className="eb" style={{ margin: '0 4px 10px' }}>Opens later</p>
      <div className="list">{later.map(o => <div key={o.what} className="li"><span className="nm">{o.what}</span><span className="end">{o.when}</span></div>)}</div>
      <p className="meta" style={{ margin: '10px 4px 0' }}>A trend through three points is noise, so each view arrives when there's enough to say something true.</p>
    </div>
  );

  const sel = picked ?? today;
  const selDate = new Date(`${sel}T00:00:00Z`);
  const daySide = (
    <div className="panel">
      <p className="eb">{sel === today ? 'Today · ' : ''}{DOW[selDate.getUTCDay()]} {longDay(sel)}</p>
      <div style={{ marginTop: 12 }}>
        {[...focus, ...log, ...input.habits.filter(h => h.kind === 'mood')].map(h => {
          const txt = valueWords(h, input, sel);
          return (
            <div key={h.id} className="between" style={{ minHeight: 34, boxShadow: 'inset 0 -1px 0 var(--line-1)' }}>
              <span className="body" style={{ fontSize: 14 }}>{h.name}</span>
              <span style={{ fontSize: 14, fontWeight: 500, color: txt === '—' ? 'var(--ink-4)' : 'var(--ink-1)' }}>{txt}</span>
            </div>
          );
        })}
      </div>
      <p className="meta" style={{ margin: '10px 0 0' }}>Click any column to see that day. Nothing here is shown unless you ask for it.</p>
    </div>
  );
  const runs = (
    <div className="panel">
      <div className="panel-h"><span className="eb">Runs</span></div>
      {focus.map(h => (
        <div key={h.id} className="between" style={{ minHeight: 36 }}>
          <span className="body" style={{ fontSize: 14 }}>{h.name}</span>
          <span className="meta">longest <b style={{ color: 'var(--ink-1)', fontWeight: 500 }}>{numbersOf(input, h, start, today).longestRun}</b></span>
        </div>
      ))}
      <p className="meta" style={{ margin: '10px 0 0' }}>A run only ends after two quiet days in a row — one never ends it. The longest one stays here permanently.</p>
    </div>
  );

  const field = hasOpened('months', day) ? monthsField(input, start, today) : [];
  const trendData = wake && hasOpened('timeTrend', day) ? trend(input, wake, start, today) : undefined;
  const band = wake?.target.band !== undefined ? { from: wake.target.band - 30, to: wake.target.band } : undefined;

  return (
    <div className="scr scr-2">
      <main className="col">
        <div className="stack-l">
          <div className="between" style={{ alignItems: 'flex-end', flexWrap: 'wrap' }}>
            <div>
              <p className="eb">Look back</p>
              <h1 className="t-l" style={{ marginTop: 6 }}>Since {longDay(start)}</h1>
              <p className="meta" style={{ margin: '4px 0 0' }}>Day {day} · {day === 1 ? 'the first day' : `${countWord(focus.length)} ${focus.length === 1 ? 'thing' : 'things'} in focus`}</p>
            </div>
          </div>

          {monthDue(model, today) && (
            <button type="button" className="panel due" data-a="nav" data-x="month" onClick={() => go('month')}>
              <span><span className="eb">Ready · once a month</span><span className="t-m">{monthOfLast(today)}, in words</span>
                <span className="meta">A few minutes, whenever you like this week. Nothing happens if you don't.</span></span>{I.chev()}
            </button>
          )}
          <div className="phone-only stack">
            {focus.map(h => {
              const n = numbersOf(input, h, start, today);
              return (
                <button key={h.id} type="button" className="panel hcard" data-a="habit" data-x={h.id} style={{ width: '100%', textAlign: 'left' }} onClick={() => go('habit', h.id)}>
                  <div className="top"><div><div className="nm">{h.name}</div><div className="unit">{unitLine(h, n)}</div></div><div className="num-xl">{n.did}</div></div>
                  <Cells list={cells(input, h, cardFrom, today, today)} style={vars({ '--cs': '17px', '--cg': '4px', '--cr': '4px' })} />
                  <div className="axis" style={vars({ '--cs': '17px', '--cg': '4px', marginTop: '6px' })}>{axisLetters(cardFrom, today).map(a => <span key={a.date} className={a.date === today ? 'now' : ''}>{a.letter}</span>)}</div>
                  <div className="foot"><span>Longest run {n.longestRun}</span><span>{I.chev()}</span></div>
                </button>
              );
            })}
          </div>
          <div className="panel said-panel phone-only"><Said words={said} /></div>
          {log.length > 0 && (
            <div className="phone-only">
              <p className="eb" style={{ margin: '0 4px 10px' }}>Also recorded · never scored</p>
              <div className="list">{log.map(h => (
                <div key={h.id} className="li" style={{ gridTemplateColumns: 'minmax(0,1fr) auto' }}>
                  <span className="nm" style={{ fontSize: 14, color: 'var(--ink-2)' }}>{h.name}</span>
                  <Cells cls="cells logc" list={cells(input, h, cardFrom, today, today)} style={vars({ '--cs': '9px', '--cg': '3px', '--cr': '2px' })} />
                </div>
              ))}</div>
            </div>
          )}

          <div className="panel panel--hero wide-only" style={{ padding: '22px 24px' }}>
            <div className="panel-h"><span className="eb">In focus</span>{LEGEND}</div>
            <div className="evi" style={{ gridTemplateColumns: '214px max-content minmax(70px,1fr)', rowGap: cs >= 20 ? 12 : 8 }}>
              <div /><div className="axis" style={cellVars}>{weekSpans(win.from, win.to).map((s, i) => <span key={i} style={{ gridColumn: `span ${s.span}`, textAlign: 'left', whiteSpace: 'nowrap' }}>{s.label}</span>)}</div><div />
              {focus.map(h => {
                const n = numbersOf(input, h, start, today);
                return [
                  <div key={`l${h.id}`} className="lab"><span className="nm">{h.name}</span><span className="sub">{h.kind === 'min' ? unitLine(h, n).replace('sessions · ', '') : unitLine(h, n)}</span></div>,
                  <Cells key={`c${h.id}`} list={cells(input, h, win.from, win.to, today)} style={cellVars} onPick={setPicked} picked={picked} />,
                  <div key={`n${h.id}`} className="ct"><b>{n.did}</b><small>{countUnit(h)}</small></div>,
                ];
              })}
              <div /><div className="axis" style={{ ...cellVars, marginTop: -2 }}>{axisLetters(win.from, win.to).map(a => <span key={a.date} className={a.date === today ? 'now' : ''} style={a.date > today ? { opacity: 0.5 } : undefined}>{a.letter}</span>)}</div><div />
            </div>
          </div>
          {log.length > 0 && (
            <div className="panel wide-only" style={{ padding: '22px 24px' }}>
              <div className="panel-h"><span className="eb">Also recorded · never scored</span><span className="meta">no counts, no runs, no score</span></div>
              <div className="evi logrow" style={{ gridTemplateColumns: '214px max-content minmax(70px,1fr)', rowGap: cs >= 20 ? 10 : 6 }}>
                {log.map(h => [
                  <div key={`l${h.id}`} className="lab"><span className="nm">{h.name}</span></div>,
                  <Cells key={`c${h.id}`} cls="cells logc" list={cells(input, h, win.from, win.to, today)} style={cellVars} onPick={setPicked} picked={picked} />,
                  <div key={`n${h.id}`} />,
                ])}
              </div>
            </div>
          )}
          <div className="panel said-panel wide-only" style={{ padding: '20px 24px' }}><Said words={said} /></div>
          {trendData && wake && (
            <div className="panel">
              <div className="panel-h" style={{ flexWrap: 'wrap' }}><span className="eb">{wake.name}</span><span className="meta">shaded band = your aim · line = each week's middle</span></div>
              <Trend data={trendData} start={start} band={band} w={wide ? 620 : 300} h={wide ? 170 : 150} />
            </div>
          )}
          {field.length > 0 && (
            <div className="panel">
              <div className="panel-h"><span className="eb">The shape of months</span>
                <div className="legend"><span><i />none</span><span><i className="f1" />one</span><span><i className="f2" />two</span><span><i className="f3" />all three</span></div></div>
              <div className="fld" style={{ display: 'flex', flexWrap: 'wrap', gap: 22 }}>
                {field.map(m => (
                  <div key={m.label}>
                    <p className="meta" style={{ margin: '0 0 8px' }}>{m.label}</p>
                    <div className="cells" style={vars({ '--rows': '7' })}>
                      {Array.from({ length: m.lead }, (_, k) => <i key={`n${k}`} className="c na" />)}
                      {m.days.map(d => <i key={d.date} className={`c${d.level ? ` f${d.level}` : ''}${d.now ? ' now' : ''}`} title={`${longDay(d.date)} · ${d.done} of the things in focus`} />)}
                    </div>
                  </div>
                ))}
              </div>
              <p className="meta" style={{ margin: '16px 0 0' }}>One square per day; brightness is how many of the things in focus that day happened. A habit that settles into Log leaves its Focus days as they were, so the count only ever covers what was in focus then.</p>
            </div>
          )}
          {day >= 8 && (
            <div className="list"><button type="button" className="li" data-a="nav" data-x="week" onClick={() => go('week')}>
              <span><span className="nm">The week, in words</span><span className="sub">Monday to Sunday, said once a week</span></span><span className="end">{I.chev()}</span></button></div>
          )}
          <div className="phone-only">{laterPanel}</div>
        </div>
      </main>
      <aside className="col side wide-only"><div className="stack-l">{daySide}{runs}{laterPanel}</div></aside>
    </div>
  );
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
/** The month before today's. */
const monthOfLast = (today: string) => MONTHS[(Number(today.slice(5, 7)) + 10) % 12] ?? '';

function datesBack(today: string, days: number): string {
  return new Date(Date.parse(`${today}T00:00:00Z`) - (days - 1) * 86_400_000).toISOString().slice(0, 10);
}
