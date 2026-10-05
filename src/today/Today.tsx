import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { resultWords, shapesOf, useApp, useClockMinute, useModel, useNav, useToday } from '../app/context.ts';
import type { Result } from '../record/results.ts';
import type { RecordCore } from '../record/core.ts';
import { sheetNow } from '../record/ops/common.ts';
import { closeDay, reopenDay, saveDayWords } from '../record/ops/days.ts';
import { clearObservation, logObservation, planDay } from '../record/ops/observations.ts';
import { rulesInput } from '../record/read.ts';
import { clockOfDay, toDayMinute } from '../rules/clock.ts';
import { addDays, clockMinuteOf, toUtcMs, weekdayOf } from '../rules/dates.ts';
import { shapeFor } from '../rules/dayLine.ts';
import { restDaysLeft } from '../rules/rest.ts';
import type { PlannedReason } from '../rules/types.ts';
import { I } from '../ui/icons.tsx';
import { useWide } from '../ui/useWide.ts';
import { Horizon } from './Horizon.tsx';
import { Row, type RowAction } from './Row.tsx';
import { hm, shapeRows, skyWords, todayView, valueText, type TodayRow } from './todayView.ts';

// Today: the morning (what today is going to be), the evening (what it was), and the closed day.
// Every save goes through the store; a save that didn't go through says so and keeps what was typed.

const DOW = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MON = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

export function longDate(date: string): string {
  const d = new Date(toUtcMs(date));
  return `${DOW[d.getUTCDay()]} ${d.getUTCDate()} ${MON[d.getUTCMonth()]}`;
}

const REASONS: readonly (readonly [PlannedReason, string])[] = [['meeting', 'meeting'], ['travelling', 'travelling'], ['unwell', 'unwell'], ['chose', 'chose to']];

function Note({ title, text }: { readonly title: string; readonly text: string }) {
  return <div className="panel note" data-a="save-note"><p className="eb">{title}</p><p className="body" style={{ margin: '8px 0 0' }}>{text}</p></div>;
}

export function Today() {
  const { core, store } = useApp();
  const { go } = useNav();
  const model = useModel();
  const today = useToday();
  const t = useClockMinute();
  const wide = useWide();
  const [open, setOpen] = useState<string | undefined>(undefined);
  const [fresh, setFresh] = useState<string | undefined>(undefined);
  const [note, setNote] = useState<{ readonly title: string; readonly text: string } | undefined>(undefined);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [restLeft, setRestLeft] = useState(false);
  const [justClosed, setJustClosed] = useState(false);
  // saves from this screen are judged by the day it opened on, for ten minutes past the boundary
  const sheet = useMemo(() => (core.session ? sheetNow(core) : undefined), [core, today]);
  const freshTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(freshTimer.current), []);
  // a laptop's keys 1–9 mark the rows in drawn order; the handler is refreshed on every draw
  const keyed = useRef<(key: string) => void>(() => {});
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as Element | null)?.closest?.('textarea,input,[contenteditable]')) return;
      if (/^[1-9]$/.test(e.key)) keyed.current(e.key);
      if (e.key === 'Escape') { setSheetOpen(false); setOpen(undefined); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const revision = store.revision();
  const input = useMemo(() => (model ? rulesInput(model) : undefined), [model, revision]);
  if (!model || !today || !input) return null;
  const view = todayView(input, model, today, t);
  const boundary = model.settings.boundary;
  const shapes = shapesOf(model.settings);
  const shape = shapeFor(today, shapes.weekday, shapes.weekend);
  const weekend = weekdayOf(today) >= 5;
  const tz = model.settings.tz;

  const run = async (write: (c: RecordCore) => Promise<Result<void>>, rowId?: string): Promise<boolean> => {
    const result = await store.run(write);
    setNote(resultWords(result));
    if (result.kind === 'Saved' && rowId) {
      setFresh(rowId);
      clearTimeout(freshTimer.current);
      freshTimer.current = setTimeout(() => setFresh(undefined), 900);
    }
    return result.kind === 'Saved';
  };

  const nowFor = (row: TodayRow) => toDayMinute(t, row.asked, boundary);
  const act = (row: TodayRow, action: RowAction) => {
    const id = row.habit.id;
    const log = (value: number | 'did' | 'partly' | 'not') => run(c => logObservation(c, { habitId: id, date: today, value, sheet }), id);
    const clear = () => run(c => clearObservation(c, { habitId: id, date: today, sheet }), id);
    switch (action.kind) {
      case 'tap':
        if (row.habit.kind === 'time' && row.value === undefined) {
          setOpen(undefined);
          void log(nowFor(row));
        } else setOpen(open === id ? undefined : id);
        return;
      case 'set': setOpen(undefined); void log(action.value); return;
      case 'add': void log((typeof row.value === 'number' ? row.value : 0) + action.minutes); return;
      case 'nudge': void log((typeof row.value === 'number' ? row.value : nowFor(row)) + action.minutes); return;
      case 'now': setOpen(undefined); void log(nowFor(row)); return;
      case 'clear': setOpen(undefined); void clear(); return;
    }
  };

  const keyRows = [...view.morningRows, ...view.eveningRows, ...view.openFocus].filter(r => r.key !== undefined);
  keyed.current = key => {
    const row = keyRows.find(r => r.key === Number(key));
    if (!row) return;
    const k = row.habit.kind;
    if (k === 'tri') act(row, row.value === 'did' ? { kind: 'clear' } : { kind: 'set', value: 'did' });
    else if (k === 'time') act(row, row.value === undefined ? { kind: 'now' } : { kind: 'clear' });
    else if (k === 'min' || k === 'count') act(row, { kind: 'add', minutes: 30 });
  };
  const rowOf = (r: TodayRow, showKey = true) => (
    <Row key={r.habit.id} row={r} open={open === r.habit.id} fresh={fresh === r.habit.id} showKey={showKey}
      onAction={a => act(r, a)} />
  );

  const marks: (readonly [string, number])[] = [];
  for (const o of model.observations.values()) {
    if (o.date !== today || o.value === undefined) continue;
    marks.push([o.habitId, o.kind === 'time' && typeof o.value === 'number' ? clockOfDay(o.value) : clockMinuteOf(o.loggedAt, tz)]);
  }

  const saveWords = (field: 'intent' | 'remark', value: string) => {
    if (((field === 'intent' ? view.intent : view.remark) ?? '') === value) return;
    void run(c => saveDayWords(c, { date: today, [field]: value, sheet }));
  };

  const top = (
    <div className="topline"><span className="eb">{longDate(today)}</span><span className="eb">Day <b>{view.dayNumber}</b></span></div>
  );
  const closedAt = view.closedAt;
  const [where, next] = skyWords(shape, t, boundary);
  const heading = closedAt !== undefined
    ? <div className="here"><h1 className="t-xl">That's the day.</h1><p className="meta">Closed at {hm(clockMinuteOf(closedAt, tz))}, lights out with it</p></div>
    : <div className="here"><h1 className="t-xl">{where}</h1><p className="meta">{next}</p></div>;

  let main: ReactNode = null;
  let side: ReactNode = null;
  if (view.part === 'closed') {
    const tomorrow = addDays(today, 1);
    const tomorrowShape = shapeFor(tomorrow, shapes.weekday, shapes.weekend);
    const first = tomorrowShape.steps[0];
    main = (
      <div className="closed-card">
        <p className="body" style={{ margin: 0 }}>Nothing else is asked of today. You can still change it until tomorrow night; after that it seals, so there's never a question of going back to fix something.</p>
        <div className="tomorrow">{I.today()}<span>{weekdayOf(tomorrow) >= 5 ? 'Tomorrow is a weekend day.' : `Tomorrow starts at ${first ? hm(first.at) : '06:00'}, with the morning check-in.`}</span></div>
        <div style={{ marginTop: 14 }}><button type="button" className="btn btn--text" data-a="reopen" style={{ paddingLeft: 0 }} onClick={() => void run(c => reopenDay(c, { date: today, sheet }))}>Open today again</button></div>
      </div>
    );
    side = (
      <div className="panel wide-only"><p className="eb">Still open</p><p className="body" style={{ margin: '10px 0 14px' }}>The diary never closes. Nothing is required to end a day — writing included.</p>
        <button type="button" className="btn btn--ghost" data-a="nav" data-x="diary" onClick={() => go('diary')}>Diary</button></div>
    );
  } else if (view.part === 'morning') {
    const focus = view.morningRows.filter(r => r.focus), log = view.morningRows.filter(r => !r.focus);
    const planned = view.morningRows.filter(r => r.planned !== undefined && r.value === undefined);
    main = (
      <>
        <div className="group">
          <div className="eb"><span>This morning</span></div>
          <div className="rows">{focus.map(r => rowOf(r))}</div>
          {log.length > 0 && <div className="rows" style={{ marginTop: 8 }}>{log.map(r => rowOf(r))}</div>}
          <button type="button" className="more" data-a="sheet" onClick={() => setSheetOpen(true)}>Something won't fit today? {I.chev()}</button>
        </div>
        <div className="group wide-only">
          <div className="eb"><span>Tonight</span><span className="dim" style={{ letterSpacing: '.06em' }}>asked in the evening</span></div>
          <div className="rows compact">{view.eveningRows.map(r => rowOf(r, wide))}</div>
        </div>
      </>
    );
    side = (
      <>
        <div className="group">
          <label className="eb field-l" htmlFor="intent">What would make today good</label>
          <textarea key={`intent-${today}`} id="intent" className="field" rows={2} placeholder="Today would be good if…" defaultValue={view.intent ?? ''}
            onBlur={e => saveWords('intent', e.currentTarget.value)} />
        </div>
        <div className="panel wide-only" style={{ marginTop: 20 }}>
          <div className="panel-h"><span className="eb">Planned rest</span></div>
          {planned.length
            ? planned.map(r => <div key={r.habit.id} className="between" style={{ minHeight: 36 }}><span className="body">{r.habit.name}</span><span className="meta">{REASONS.find(([k]) => k === r.planned)?.[1] ?? 'rest day'}</span></div>)
            : <p className="meta" style={{ margin: '0 0 12px' }}>Nothing planned off today. If something lands on a habit's time, say so here and tonight it's kept as planned — not as a gap.</p>}
          <button type="button" className="btn btn--ghost" data-a="sheet" style={{ marginTop: 6 }} onClick={() => setSheetOpen(true)}>Plan one</button>
        </div>
        {keyRows.length > 0 && <p className="meta wide-only" style={{ margin: '18px 4px 0' }}><span className="kbd">1</span>–<span className="kbd">{keyRows.length}</span> mark a row</p>}
      </>
    );
  } else {
    const chip = (r: TodayRow) => {
      const value = r.planned !== undefined && r.value === undefined ? 'planned rest' : r.habit.kind !== 'tri' ? valueText(r.habit.kind, r.value) : r.value === 'partly' ? 'partly' : '';
      const lit = r.state === 'did' || r.state === 'partly';
      return <span key={r.habit.id} className={`chip${lit ? '' : ' idle'}`}><span>{r.habit.name.toLowerCase()}</span>{value && <b>{value}</b>}</span>;
    };
    const left = restDaysLeft([...model.days.values()].filter(d => d.restDay).map(d => d.date), today, model.settings.journeyStart);
    const isRest = model.days.get(today)?.restDay === true;
    main = (
      <>
        <div className="group"><div className="eb"><span>Tonight</span></div><div className="rows">{view.eveningRows.map(r => rowOf(r))}</div></div>
        <div className="group">
          <div className="eb"><span>Earlier today</span></div>
          {view.openFocus.length > 0 && <div className="rows" style={{ marginBottom: 10 }}>{view.openFocus.map(r => rowOf(r))}</div>}
          {view.earlier.length > 0 && <div className="earlier">{view.earlier.map(chip)}</div>}
        </div>
      </>
    );
    side = (
      <>
        {view.intent && <div className="panel wide-only" style={{ marginBottom: 22 }}><p className="eb">This morning you wrote</p><p className="said" style={{ marginTop: 10 }}>{view.intent}</p></div>}
        <div className="group" style={{ marginTop: 0 }}>
          <label className="eb field-l" htmlFor="remark">A word about today</label>
          <textarea key={`remark-${today}`} id="remark" className="field" rows={2} placeholder="Today was…" defaultValue={view.remark ?? ''}
            onBlur={e => saveWords('remark', e.currentTarget.value)} />
        </div>
        {view.restOffer && !restLeft && (
          <div className="panel rest">
            <p className="eb">A rest day</p>
            <p className="body">{left > 1 ? 'There are two free this month.' : "There's one free this month."} Using it keeps today as planned rest in Look back — a marked square, not an empty one.</p>
            <div className="two">
              <button type="button" className="btn btn--secondary" data-a="rest" data-x="use" onClick={() => void run(c => planDay(c, { date: today, restDay: true, sheet }))}>Use it</button>
              <button type="button" className="btn btn--secondary" data-a="rest" data-x="leave" onClick={() => setRestLeft(true)}>Leave it</button>
            </div>
          </div>
        )}
        {isRest && <div className="panel rest"><p className="eb">A rest day</p><p className="body" style={{ marginBottom: 0 }}>Today is kept as planned rest.</p></div>}
        <div style={{ marginTop: 20 }}>
          <button type="button" className="btn btn--primary wide" data-a="close" onClick={() => {
            void run(c => closeDay(c, { date: today, lightsOut: toDayMinute(t, 'evening', boundary), sheet })).then(ok => {
              if (!ok) return;
              setJustClosed(true);
              setTimeout(() => setJustClosed(false), 1600);
              window.scrollTo(0, 0);
            });
          }}>That's the day <span className="sub">· lights out {hm(t)}</span></button>
          <p className="meta" style={{ textAlign: 'center', margin: '10px 0 0' }}>You can still change today until tomorrow night.</p>
        </div>
      </>
    );
  }

  const shapeAside = (
    <>
      <p className="eb">The shape of {weekend ? 'a weekend day' : 'today'}</p>
      <div className="shape">
        {shapeRows(shape).map(s => {
          const on = closedAt === undefined && t >= s.at && t < s.end;
          const ms = marks.filter(([, m]) => m >= s.at && m < s.end && m <= t);
          return (
            <div key={s.at} className={`sh${on ? ' is-now' : ''}`}>
              <span className="tm">{hm(s.at)}</span>
              <span className="wh">{s.label}{on && <span className="nowpill">{hm(t)}</span>}
                {ms.length > 0 && <span className="marks">{ms.map(([id, m]) => <span key={id}>{hm(m)} {model.habits.get(id)?.name.toLowerCase()}</span>)}</span>}</span>
            </div>
          );
        })}
      </div>
      <p className="meta" style={{ margin: '16px 14px 0' }}>Reminder text. It has no ticks and nothing in it is scored — it's what a good {weekend ? 'weekend day' : 'weekday'} looks like, not a list to complete.</p>
    </>
  );

  return (
    <>
      <div className="scr scr-3 today">
        <aside className="col wide-only">{shapeAside}</aside>
        <main className="col">
          {top}
          <div className="sky">
            {heading}
            <div className="phone-only"><Horizon shape={shape} t={t} marks={marks} fresh={fresh} wideLabels={false} setting={justClosed} boundary={boundary} /></div>
            <div className="wide-only"><Horizon shape={shape} t={t} marks={marks} fresh={fresh} wideLabels setting={justClosed} boundary={boundary} /></div>
          </div>
          {main}
          {note && <div style={{ marginTop: 16 }}><Note {...note} /></div>}
        </main>
        <aside className="col side">{side}</aside>
      </div>
      {sheetOpen && <Layer><NotTodaySheet rows={[...view.morningRows, ...view.openFocus].filter(r => r.focus && (r.value === undefined))}
        onClose={() => setSheetOpen(false)}
        onPlan={async (plans, unplan) => {
          let ok = true;
          if (plans.length) ok = await run(c => planDay(c, { date: today, plans, sheet }));
          for (const id of unplan) if (ok) ok = await run(c => clearObservation(c, { habitId: id, date: today, sheet }));
          if (ok) setSheetOpen(false);
        }} /></Layer>}
    </>
  );
}

/** Draws into the app's layer above the screen, where sheets live. */
function Layer({ children }: { readonly children: ReactNode }) {
  const layer = document.getElementById('layer');
  return layer ? createPortal(children, layer) : <>{children}</>;
}

function NotTodaySheet(p: {
  readonly rows: readonly TodayRow[];
  onClose(): void;
  onPlan(plans: readonly { readonly habitId: string; readonly reason: PlannedReason }[], unplan: readonly string[]): Promise<void>;
}) {
  const [on, setOn] = useState<ReadonlySet<string>>(() => new Set(p.rows.filter(r => r.planned !== undefined).map(r => r.habit.id)));
  const [reason, setReason] = useState<PlannedReason | undefined>(undefined);
  const toggle = (id: string) => setOn(prev => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
  });
  return (
    <>
      <div className="scrim" data-a="sheet-x" onClick={p.onClose} />
      <div className="sheet" role="dialog" aria-label="Plan rest">
        <div className="grab" />
        <p className="eb">Said in the morning</p>
        <h2 className="t-l" style={{ margin: '8px 0 8px' }}>Something won't fit today?</h2>
        <p className="body" style={{ margin: '0 0 18px' }}>Mark it now. Tonight it's kept as planned rest — a marked square in Look back, not an empty one. You don't owe a reason.</p>
        <div className="rows">
          {p.rows.map(r => (
            <button key={r.habit.id} type="button" className="row" data-s={on.has(r.habit.id) ? 'planned' : ''} data-a="nt" data-x={r.habit.id} onClick={() => toggle(r.habit.id)}>
              <span className="dot" /><span><span className="nm">{r.habit.name}</span><span className="sub">{r.habit.sub}</span></span>
              <span className={`toggle${on.has(r.habit.id) ? ' on' : ''}`} aria-hidden="true" />
            </button>
          ))}
        </div>
        <p className="eb" style={{ margin: '20px 4px 10px' }}>A reason, if you like</p>
        <div className="opts four" style={{ marginTop: 0 }}>
          {REASONS.map(([k, label]) => (
            <button key={k} type="button" className={`opt${reason === k ? ' on' : ''}`} data-a="reason" data-x={k} onClick={() => setReason(reason === k ? undefined : k)}>{label}</button>
          ))}
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginTop: 22 }}>
          <button type="button" className="btn btn--secondary" data-a="sheet-x" onClick={p.onClose}>Leave it</button>
          <button type="button" className="btn btn--primary" data-a="sheet-ok" onClick={() => {
            const was = new Set(p.rows.filter(r => r.planned !== undefined).map(r => r.habit.id));
            const plans = [...on].filter(id => !was.has(id)).map(habitId => ({ habitId, reason: reason ?? 'chose' }));
            const unplan = [...was].filter(id => !on.has(id));
            void p.onPlan(plans, unplan);
          }}>Plan it</button>
        </div>
      </div>
    </>
  );
}
