import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { resultWords, shapesOf, useApp, useClockMinute, useModel, useNav, useSaveAtLeave, useToday } from '../app/context.ts';
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
import { draft } from './draft.ts';
import { Horizon } from './Horizon.tsx';
import { Row, type RowAction } from './Row.tsx';
import { asksForTime, hm, shapeRows, shownDay, skyWords, todayView, valueText, wakesAhead, yesterdayOf, type TodayRow } from './todayView.ts';

// Today: the morning (what today is going to be), the evening (what it was), and the closed day.
// Every save goes through the store; a save that didn't go through says so and keeps what was typed.
// Yesterday is the same screen for the day before (`asked` is its date), its evening or its closed
// card, while the record still takes changes to it (§8 #21); after the boundary it is today again.

const DOW = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MON = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

export function longDate(date: string): string {
  const d = new Date(toUtcMs(date));
  return `${DOW[d.getUTCDay()]} ${d.getUTCDate()} ${MON[d.getUTCMonth()]}`;
}

const REASONS: readonly (readonly [PlannedReason, string])[] = [['meeting', 'meeting'], ['travelling', 'travelling'], ['unwell', 'unwell'], ['chose', 'chose to']];

// A write that fails outright (not a refusal the record itself returned) gets the same shape of
// words as a refusal, so a screen never goes silent on it.
const NOT_SAVED = { title: 'Not saved', text: "That couldn't be saved. What you wrote is still here." };

type WordsField = 'intent' | 'remark';
const LABEL: Readonly<Record<WordsField, string>> = { intent: 'What would make today good', remark: 'A word about today' };

/** Words whose field went away before they could be saved, kept on screen until they are. */
interface Unsaved {
  readonly field: WordsField;
  readonly date: string;
  readonly text: string;
}

function Note({ title, text }: { readonly title: string; readonly text: string }) {
  return <div className="panel note" data-a="save-note"><p className="eb">{title}</p><p className="body" style={{ margin: '8px 0 0' }}>{text}</p></div>;
}

export function Today({ asked = '' }: { readonly asked?: string }) {
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
  const [unsaved, setUnsaved] = useState<Unsaved | undefined>(undefined);
  // guards That's the day / Open today again against a second tap landing before the first finishes
  const closing = useRef(false);
  const [busy, setBusy] = useState(false);
  // saves from this screen are judged by the day it opened on, for ten minutes past the boundary
  const sheet = useMemo(() => (core.session ? sheetNow(core) : undefined), [core, today]);
  const freshTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(freshTimer.current), []);
  // moving between today and yesterday starts the screen afresh: nothing open, no note, no sheet
  const { day, past } = model && today ? shownDay(asked, today, model.settings.journeyStart) : { day: today, past: false };
  const [shown, setShown] = useState(day);
  if (shown !== day) {
    setShown(day);
    setOpen(undefined);
    setNote(undefined);
    setSheetOpen(false);
    setRestLeft(false);
  }
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
  if (!model || !today || !day || !input) return null;
  const view = todayView(input, model, day, t, past);
  const boundary = model.settings.boundary;
  const shapes = shapesOf(model.settings);
  const shape = shapeFor(day, shapes.weekday, shapes.weekend);
  const weekend = weekdayOf(day) >= 5;
  const yesterday = past ? undefined : yesterdayOf(today, model.settings.journeyStart);
  const tz = model.settings.tz;

  const run = async (write: (c: RecordCore) => Promise<Result<void>>, rowId?: string): Promise<boolean> => {
    try {
      const result = await store.run(write);
      setNote(resultWords(result));
      if (result.kind === 'Saved' && rowId) {
        setFresh(rowId);
        clearTimeout(freshTimer.current);
        freshTimer.current = setTimeout(() => setFresh(undefined), 900);
      }
      return result.kind === 'Saved';
    } catch {
      setNote(NOT_SAVED);
      return false;
    }
  };

  /** Keeps a second tap on a slow phone from landing before the first finishes, so it never sees a
   * refusal that only exists because the first tap already went through. */
  const guarded = (job: () => Promise<void>) => () => {
    if (closing.current) return;
    closing.current = true;
    setBusy(true);
    void job().finally(() => { closing.current = false; setBusy(false); });
  };

  const nowFor = (row: TodayRow) => toDayMinute(t, row.asked, boundary);
  // in the evening a morning time row (or a planned one) asks for its time rather than taking now;
  // a day-ahead row is a wake-up happening now, so it takes now
  const asks = (row: TodayRow, ahead = false) => !ahead && asksForTime(row, view.part, past);
  // before the boundary a wake-up goes to the day ahead (B-5). It is judged when it is tapped: the
  // sheet opened earlier in the evening would judge it by then, when the day ahead took no values.
  const aheadDay = addDays(today, 1);
  const rowId = (id: string, ahead: boolean) => (ahead ? `ahead:${id}` : id);
  const logTo = (id: string, date: string, value: number | 'did' | 'partly' | 'not') =>
    run(c => logObservation(c, { habitId: id, date, value, sheet: date === day ? sheet : undefined }), rowId(id, date !== day));
  const act = (row: TodayRow, action: RowAction, ahead = false) => {
    const id = row.habit.id;
    const date = ahead ? aheadDay : day;
    const log = (value: number | 'did' | 'partly' | 'not') => logTo(id, date, value);
    const clear = () => run(c => clearObservation(c, { habitId: id, date, sheet: ahead ? undefined : sheet }), rowId(id, ahead));
    switch (action.kind) {
      case 'tap':
        if (row.habit.kind === 'time' && row.value === undefined && !asks(row, ahead)) {
          setOpen(undefined);
          void log(nowFor(row));
        } else setOpen(open === rowId(id, ahead) ? undefined : rowId(id, ahead));
        return;
      case 'set': setOpen(undefined); void log(action.value); return;
      case 'add': {
        const next = (typeof row.value === 'number' ? row.value : 0) + action.by;
        void log(row.habit.kind === 'count' ? Math.max(0, Math.min(999, next)) : next);
        return;
      }
      case 'nudge': void log((typeof row.value === 'number' ? row.value : nowFor(row)) + action.minutes); return;
      case 'now': setOpen(undefined); void log(nowFor(row)); return;
      case 'at':
        setOpen(undefined);
        // tonight's empty wake-up given a time that has just happened, before the boundary: the day ahead's
        if (!ahead && row.value === undefined && view.ahead.some(r => r.habit.id === id) && wakesAhead(action.clock, t, boundary)) void logTo(id, aheadDay, action.clock);
        else void log(toDayMinute(action.clock, row.asked, boundary));
        return;
      case 'clear': setOpen(undefined); void clear(); return;
    }
  };

  const keyRows = [...view.ahead, ...view.morningRows, ...view.eveningRows, ...view.openFocus, ...view.earlier].filter(r => r.key !== undefined);
  keyed.current = key => {
    const row = keyRows.find(r => r.key === Number(key));
    if (!row) return;
    const ahead = view.ahead.includes(row);
    const k = row.habit.kind;
    if (k === 'tri') act(row, row.value === 'did' ? { kind: 'clear' } : { kind: 'set', value: 'did' });
    else if (k === 'time') act(row, row.value !== undefined ? { kind: 'clear' } : asks(row, ahead) ? { kind: 'tap' } : { kind: 'now' }, ahead);
    else if (k === 'min') act(row, { kind: 'add', by: 30 });
    else if (k === 'count') act(row, { kind: 'add', by: 1 });
  };
  const rowOf = (r: TodayRow, showKey = true, ahead = false) => (
    <Row key={rowId(r.habit.id, ahead)} row={r} open={open === rowId(r.habit.id, ahead)} fresh={fresh === rowId(r.habit.id, ahead)} showKey={showKey}
      ask={asks(r, ahead)} onAction={a => act(r, a, ahead)} />
  );
  // between midnight and the boundary, on the closed card and in the evening: a wake-up for the day ahead
  const aheadGroup = view.ahead.length > 0 && (
    <div className="group" data-a="ahead">
      <div className="eb"><span>Up already?</span><span className="dim" style={{ letterSpacing: '.06em' }}>it goes with {DOW[new Date(toUtcMs(aheadDay)).getUTCDay()]}</span></div>
      <div className="rows">{view.ahead.map(r => rowOf(r, true, true))}</div>
    </div>
  );

  const marks: (readonly [string, number])[] = [];
  for (const o of model.observations.values()) {
    if (o.date !== day || o.value === undefined) continue;
    marks.push([o.habitId, o.kind === 'time' && typeof o.value === 'number' ? clockOfDay(o.value) : clockMinuteOf(o.loggedAt, tz)]);
  }

  // words go to the day they were typed for, even when the field goes away after the day has moved on
  const saveWords = async (field: WordsField, date: string, text: string) => {
    const ok = await run(c => saveDayWords(c, { date, [field]: text, sheet }));
    if (ok) setUnsaved(u => (u && u.field === field && u.date === date ? undefined : u));
    return ok;
  };
  const wordsField = (field: WordsField, placeholder: string, saved: string | undefined) => (
    <WordsInput key={`${field}-${day}`} id={field} placeholder={placeholder} saved={saved ?? ''}
      typed={unsaved?.field === field && unsaved.date === day ? unsaved.text : undefined}
      save={text => saveWords(field, day, text)} lost={text => setUnsaved({ field, date: day, text })} />
  );
  const drawnField: WordsField | undefined = view.part === 'morning' ? 'intent' : view.part === 'evening' ? 'remark' : undefined;
  const held = unsaved && !(unsaved.field === drawnField && unsaved.date === day) ? unsaved : undefined;

  const top = (
    <>
      {past && <button type="button" className="btn btn--text" data-a="nav" data-x="today" style={{ paddingLeft: 0, gap: 4 }} onClick={() => go('today')}>{I.back({ width: 18, height: 18 })}Today</button>}
      <div className="topline"><span className="eb">{past ? `Yesterday · ${longDate(day)}` : longDate(day)}</span><span className="eb">Day <b>{view.dayNumber}</b></span></div>
    </>
  );
  // yesterday is over: its sky is drawn at lights out, with no "now" on it
  const skyAt = past ? shape.lightsOut : t;
  const until = `until today ends, at ${hm(boundary)}`;
  const closedAt = view.closedAt;
  const [where, next] = skyWords(shape, t, boundary);
  const heading = closedAt !== undefined
    ? <div className="here"><h1 className="t-xl">That's the day.</h1><p className="meta">{past ? `Closed at ${hm(clockMinuteOf(closedAt, tz))}` : <>Closed at {hm(clockMinuteOf(closedAt, tz))}, lights out with it</>}</p></div>
    : past
      ? <div className="here"><h1 className="t-xl">Yesterday</h1><p className="meta">It stays open {until}.</p></div>
      : <div className="here"><h1 className="t-xl">{where}</h1><p className="meta">{next}</p></div>;
  // from today, the way to yesterday while it can still be changed
  const toYesterday = yesterday !== undefined && (
    <button type="button" className="more" data-a="yesterday" onClick={() => go('today', yesterday)}>Yesterday, {longDate(yesterday)} {I.chev()}</button>
  );

  let main: ReactNode = null;
  let side: ReactNode = null;
  if (view.part === 'closed' && past) {
    main = (
      <div className="closed-card">
        <p className="body" style={{ margin: 0 }}>Nothing else is asked of it. You can still change it {until}; after that it seals, so there's never a question of going back to fix something.</p>
        <div style={{ marginTop: 14 }}><button type="button" className="btn btn--text" data-a="reopen" disabled={busy} style={{ paddingLeft: 0 }}
          onClick={guarded(async () => { await run(c => reopenDay(c, { date: day, sheet })); })}>Open it again</button></div>
      </div>
    );
  } else if (view.part === 'closed') {
    const tomorrow = addDays(today, 1);
    const tomorrowShape = shapeFor(tomorrow, shapes.weekday, shapes.weekend);
    const first = tomorrowShape.steps[0];
    main = (
      <>
        {aheadGroup}
        <div className="closed-card">
          <p className="body" style={{ margin: 0 }}>Nothing else is asked of today. You can still change it until tomorrow night; after that it seals, so there's never a question of going back to fix something.</p>
          <div className="tomorrow">{I.today()}<span>{weekdayOf(tomorrow) >= 5 ? 'Tomorrow is a weekend day.' : `Tomorrow starts at ${first ? hm(first.at) : '06:00'}, with the morning check-in.`}</span></div>
          <div style={{ marginTop: 14 }}><button type="button" className="btn btn--text" data-a="reopen" disabled={busy} style={{ paddingLeft: 0 }}
            onClick={guarded(async () => { await run(c => reopenDay(c, { date: day, sheet })); })}>Open today again</button></div>
        </div>
        {toYesterday}
      </>
    );
  }
  if (view.part === 'closed') {
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
          <button type="button" className="more" data-a="sheet" onClick={() => { setNote(undefined); setSheetOpen(true); }}>Something won't fit today? {I.chev()}</button>
          {toYesterday}
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
          {wordsField('intent', 'Today would be good if…', view.intent)}
        </div>
        <div className="panel wide-only" style={{ marginTop: 20 }}>
          <div className="panel-h"><span className="eb">Planned rest</span></div>
          {planned.length
            ? planned.map(r => <div key={r.habit.id} className="between" style={{ minHeight: 36 }}><span className="body">{r.habit.name}</span><span className="meta">{REASONS.find(([k]) => k === r.planned)?.[1] ?? 'rest day'}</span></div>)
            : <p className="meta" style={{ margin: '0 0 12px' }}>Nothing planned off today. If something lands on a habit's time, say so here and tonight it's kept as planned — not as a gap.</p>}
          <button type="button" className="btn btn--ghost" data-a="sheet" style={{ marginTop: 6 }} onClick={() => { setNote(undefined); setSheetOpen(true); }}>Plan one</button>
        </div>
        {keyRows.length > 0 && <p className="meta wide-only" style={{ margin: '18px 4px 0' }}><span className="kbd">1</span>–<span className="kbd">{keyRows.length}</span> mark a row</p>}
      </>
    );
  } else {
    const chip = (r: TodayRow) => {
      const value = r.planned !== undefined && r.value === undefined ? 'planned rest' : r.habit.kind !== 'tri' ? valueText(r.habit.kind, r.value) : r.value === 'partly' ? 'partly' : '';
      const lit = r.state === 'did' || r.state === 'partly';
      return (
        <button key={r.habit.id} type="button" className={`chip${lit ? '' : ' idle'}`} data-a="chip" data-x={r.habit.id} onClick={() => act(r, { kind: 'tap' })}>
          <span>{r.habit.name.toLowerCase()}</span>{value && <b>{value}</b>}{r.key !== undefined && <span className="kbd">{r.key}</span>}
        </button>
      );
    };
    // a chip tapped open is drawn as its row again, in its place among the Focus rows, until it is answered or closed
    const focusRows = [...view.openFocus, ...view.earlier.filter(r => r.habit.id === open)].sort((a, b) => a.habit.order - b.habit.order);
    const chips = view.earlier.filter(r => r.habit.id !== open);
    const left = restDaysLeft([...model.days.values()].filter(d => d.restDay).map(d => d.date), day, model.settings.journeyStart);
    const isRest = model.days.get(day)?.restDay === true;
    main = (
      <>
        {aheadGroup}
        <div className="group"><div className="eb"><span>{past ? 'That evening' : 'Tonight'}</span></div><div className="rows">{view.eveningRows.map(r => rowOf(r))}</div></div>
        <div className="group">
          <div className="eb"><span>{past ? 'Earlier that day' : 'Earlier today'}</span></div>
          {focusRows.length > 0 && <div className="rows" style={{ marginBottom: 10 }}>{focusRows.map(r => rowOf(r))}</div>}
          {chips.length > 0 && <div className="earlier">{chips.map(chip)}</div>}
        </div>
        {toYesterday}
      </>
    );
    side = (
      <>
        {view.intent && <div className="panel wide-only" style={{ marginBottom: 22 }}><p className="eb">{past ? 'That morning you wrote' : 'This morning you wrote'}</p><p className="said" style={{ marginTop: 10 }}>{view.intent}</p></div>}
        <div className="group" style={{ marginTop: 0 }}>
          <label className="eb field-l" htmlFor="remark">{past ? 'A word about yesterday' : 'A word about today'}</label>
          {wordsField('remark', past ? 'Yesterday was…' : 'Today was…', view.remark)}
        </div>
        {view.restOffer && !restLeft && (
          <div className="panel rest">
            <p className="eb">A rest day</p>
            <p className="body">{left > 1 ? 'There are two free this month.' : "There's one free this month."} Using it keeps today as planned rest in Look back — a marked square, not an empty one.</p>
            <div className="two">
              <button type="button" className="btn btn--secondary" data-a="rest" data-x="use" onClick={() => void run(c => planDay(c, { date: day, restDay: true, sheet }))}>Use it</button>
              <button type="button" className="btn btn--secondary" data-a="rest" data-x="leave" onClick={() => setRestLeft(true)}>Leave it</button>
            </div>
          </div>
        )}
        {isRest && <div className="panel rest"><p className="eb">A rest day</p><p className="body" style={{ marginBottom: 0 }}>{past ? 'Yesterday' : 'Today'} is kept as planned rest.</p></div>}
        <div style={{ marginTop: 20 }}>
          <button type="button" className="btn btn--primary wide" data-a="close" disabled={busy} onClick={guarded(async () => {
            // yesterday closes as it is: its lights out was then, not now
            const ok = await run(c => closeDay(c, { date: day, lightsOut: past ? undefined : toDayMinute(t, 'evening', boundary), sheet }));
            if (!ok) return;
            setJustClosed(true);
            setTimeout(() => setJustClosed(false), 1600);
            window.scrollTo(0, 0);
          })}>That's the day{!past && <> <span className="sub">· lights out {hm(t)}</span></>}</button>
          {!past && <p className="meta" style={{ textAlign: 'center', margin: '10px 0 0' }}>You can still change today until tomorrow night.</p>}
        </div>
      </>
    );
  }

  const shapeAside = (
    <>
      <p className="eb">The shape of {weekend ? 'a weekend day' : past ? 'yesterday' : 'today'}</p>
      <div className="shape">
        {shapeRows(shape).map(s => {
          const on = !past && closedAt === undefined && t >= s.at && t < s.end;
          const ms = marks.filter(([, m]) => m >= s.at && m < s.end && (past || m <= t));
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
            <div className="phone-only"><Horizon shape={shape} t={skyAt} marks={marks} fresh={fresh} wideLabels={false} setting={justClosed} boundary={boundary} /></div>
            <div className="wide-only"><Horizon shape={shape} t={skyAt} marks={marks} fresh={fresh} wideLabels setting={justClosed} boundary={boundary} /></div>
          </div>
          {main}
          {held && (
            <div className="panel" data-a="unsaved-words" style={{ marginTop: 16 }}>
              <p className="eb">{LABEL[held.field]}</p>
              <p className="said" style={{ marginTop: 10 }}>{held.text}</p>
              <p className="meta" style={{ margin: '10px 0 14px' }}>Not saved yet. It goes with {longDate(held.date)}.</p>
              <div className="two">
                <button type="button" className="btn btn--secondary" data-a="unsaved" data-x="save" onClick={() => void saveWords(held.field, held.date, held.text)}>Try again</button>
                <button type="button" className="btn btn--secondary" data-a="unsaved" data-x="leave" onClick={() => setUnsaved(undefined)}>Let it go</button>
              </div>
            </div>
          )}
          {note && !sheetOpen && <div style={{ marginTop: 16 }}><Note {...note} /></div>}
        </main>
        <aside className="col side">{side}</aside>
      </div>
      {sheetOpen && <Layer><NotTodaySheet rows={[...view.morningRows, ...view.openFocus].filter(r => r.focus && (r.value === undefined))}
        note={note}
        onClose={() => { setSheetOpen(false); setNote(undefined); }}
        onPlan={async (plans, unplan) => {
          let ok = true;
          if (plans.length) ok = await run(c => planDay(c, { date: day, plans, sheet }));
          for (const id of unplan) if (ok) ok = await run(c => clearObservation(c, { habitId: id, date: day, sheet }));
          if (ok) setSheetOpen(false);
        }} /></Layer>}
    </>
  );
}

/**
 * One of Today's two fields. It belongs to one day (its key carries the date) and keeps what was
 * typed in a draft, so words still in it when it goes away are saved to that day, and words in it
 * when the app is left are saved before the lock.
 */
function WordsInput(p: {
  readonly id: WordsField;
  readonly placeholder: string;
  readonly saved: string;
  readonly typed?: string;
  save(text: string): Promise<boolean>;
  lost(text: string): void;
}) {
  const [words] = useState(() => draft(p.saved, p.save, p.lost, p.typed));
  const field = useRef<HTMLTextAreaElement>(null);
  useSaveAtLeave(field, () => words.flush());
  useEffect(() => {
    words.open();
    return () => words.close();
  }, [words]);
  return (
    <textarea ref={field} id={p.id} className="field" rows={2} placeholder={p.placeholder} defaultValue={p.typed ?? p.saved}
      onChange={e => words.type(e.currentTarget.value)} onBlur={() => words.flush()} />
  );
}

/** Draws into the app's layer above the screen, where sheets live. */
function Layer({ children }: { readonly children: ReactNode }) {
  const layer = document.getElementById('layer');
  return layer ? createPortal(children, layer) : <>{children}</>;
}

function NotTodaySheet(p: {
  readonly rows: readonly TodayRow[];
  readonly note?: { readonly title: string; readonly text: string };
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
        {p.note && <div style={{ marginTop: 16 }}><Note {...p.note} /></div>}
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
