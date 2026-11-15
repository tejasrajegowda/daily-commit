import { useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { resultWords, shapesOf, useApp, useBackLayer, useModel, useNav, useToday } from '../app/context.ts';
import type { HabitRecord } from '../record/model.ts';
import { deleteCue, saveCue } from '../record/ops/cues.ts';
import { createHabit, editHabit, retireHabit, returnHabit, swapFocus } from '../record/ops/habits.ts';
import { clearObservation, planDay } from '../record/ops/observations.ts';
import type { Result } from '../record/results.ts';
import type { RecordCore } from '../record/core.ts';
import { position, type DayShape } from '../rules/dayLine.ts';
import { addDays } from '../rules/dates.ts';
import type { LocalDate, PlannedReason, Weekday } from '../rules/types.ts';
import { I } from '../ui/icons.tsx';
import { useWide } from '../ui/useWide.ts';
import {
  aheadChip, aheadLabel, aheadWords, changeOf, daysAhead, EMPTY_FORM, focusOn, formOf, formProblems, habitLine, monthOf, newHabitOf, PLAN_WORDS,
  planLists, slotNote, type DayAhead, type HabitForm,
} from './planView.ts';

// Plan: Focus as three slots, Log beside it, days ahead, the day's shapes, and the editor. On a phone
// the editor is a sheet; on a laptop it is the middle panel. A habit's kind is fixed once it exists.
// Days ahead is where a rest day, or a Focus habit marked off, is planned before its day begins.

const LETTERS = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];
const KINDS = [['time', 'A time'], ['tri', 'Did / partly'], ['min', 'Minutes'], ['count', 'A count']] as const;
const hm = (m: number) => `${String(Math.floor(m / 60) % 24).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
const fromHm = (s: string) => { const m = /^(\d{1,2}):(\d{2})$/.exec(s); return m ? Number(m[1]) * 60 + Number(m[2]) : undefined; };

// A write that fails outright (not a refusal the record itself returned) gets the same shape of
// words as a refusal, so the editor never goes silent on it.
const NOT_SAVED = { title: 'Not saved', text: "That couldn't be saved. What you wrote is still here." };
const REASONS: readonly (readonly [PlannedReason, string])[] = [['meeting', 'meeting'], ['travelling', 'travelling'], ['unwell', 'unwell'], ['chose', 'chose to']];

function Layer({ children }: { readonly children: ReactNode }) {
  const layer = document.getElementById('layer');
  return layer ? createPortal(children, layer) : <>{children}</>;
}

function MiniStrip({ shape }: { readonly shape: DayShape }) {
  return (
    <span className="mini-strip" aria-hidden="true">
      {shape.blocks.map(b => <i key={b.start} style={{ left: `${position(shape, b.start)}%`, width: `${position(shape, b.end) - position(shape, b.start)}%` }} />)}
      <b style={{ left: `${position(shape, shape.lightsOut)}%` }} />
    </span>
  );
}

export function Plan() {
  const { core, store } = useApp();
  const model = useModel();
  const today = useToday();
  const wide = useWide();
  const { go } = useNav();
  const [editing, setEditing] = useState<string | 'new' | undefined>(undefined);
  const [newId, setNewId] = useState(() => core.newId());
  const [resetAt, setResetAt] = useState(0);
  const [ahead, setAhead] = useState<LocalDate | undefined>(undefined);
  useBackLayer(!wide && editing !== undefined, () => { setEditing(undefined); setResetAt(n => n + 1); });
  useBackLayer(ahead !== undefined, () => setAhead(undefined));
  if (!model || !today) return null;
  const lists = planLists(model, today);
  const shapes = shapesOf(model.settings);
  const chosen = editing === 'new' ? undefined : editing ? model.habits.get(editing) : wide ? lists.focus.find(Boolean) ?? lists.log[0] : undefined;
  const filled = lists.focus.filter(Boolean).length;
  const days = daysAhead(model, today);
  const planned = days.filter(d => d.rest || d.plans.length > 0);
  const reasonOf = (r: PlannedReason) => REASONS.find(([k]) => k === r)?.[1] ?? r;
  const open = (id: string | 'new') => setEditing(id);
  // Cancel discards edits by remounting the editor, even one shown by default with nothing chosen
  const cancel = () => { setEditing(undefined); setResetAt(n => n + 1); };

  const list = (
    <>
      {/* a phone has no rail, so Settings is reached from here */}
      <div className="between"><h1 className="t-l">Plan</h1>
        <button type="button" className="btn btn--text phone-only" data-a="nav" data-x="settings" aria-label="Settings" onClick={() => go('settings')}>{I.gear()}</button></div>
      <p className="meta" style={{ margin: '4px 0 0' }}>{PLAN_WORDS.intro}</p>
      <div className="group">
        <div className="eb"><span>Focus · three slots</span><span>scored</span></div>
        <div className="slots">
          {lists.focus.map((h, i) => h
            ? <button key={h.id} type="button" className={`slot${chosen?.id === h.id ? ' on' : ''}`} data-a="edit" data-x={h.id} onClick={() => open(h.id)}>
                <span className="slot-n">{i + 1}</span><span><span className="nm">{h.name}</span><span className="sub">{habitLine(h, today)}</span></span><span className="end">{I.chev()}</span></button>
            : <div key={`e${i}`} className="slot empty"><span className="slot-n">{i + 1}</span><span><span className="nm">Empty</span><span className="sub">room for one more thing</span></span></div>)}
        </div>
        <p className="meta slot-note">{slotNote(filled)}</p>
      </div>
      <div className="group">
        <div className="eb"><span>Log · never scored</span><span>{lists.log.length}</span></div>
        <div className="list">
          {lists.log.map(h => (
            <button key={h.id} type="button" className={`li pl-log${chosen?.id === h.id ? ' on' : ''}${h.settledAt ? ' settled' : ''}`} data-a="edit" data-x={h.id} onClick={() => open(h.id)}>
              <span><span className="nm">{h.name}</span><span className="sub">{h.settledAt ? 'settled · moved here from Focus' : habitLine(h, today)}</span></span><span className="end">{I.chev()}</span></button>
          ))}
        </div>
        <button type="button" className="add" data-a="add" onClick={() => { setNewId(core.newId()); open('new'); }}>{I.plus()}Add to Log</button>
      </div>
      {lists.retired.length > 0 && (
        <div className="group"><div className="eb"><span>Retired</span></div>
          <div className="list">{lists.retired.map(h => (
            <button key={h.id} type="button" className="li pl-log" data-a="edit" data-x={h.id} onClick={() => open(h.id)}><span><span className="nm">{h.name}</span><span className="sub">retired · every day it was logged stays in Look back</span></span><span className="end">{I.chev()}</span></button>
          ))}</div></div>
      )}
      <div className="group" data-a="ahead">
        <div className="eb"><span>Days ahead · rest and not today</span></div>
        {planned.length > 0 && <div className="list">{planned.map(d => (
          <button key={d.date} type="button" className="li pl-log" data-a="ahead-day" data-x={d.date} onClick={() => setAhead(d.date)}>
            <span><span className="nm">{aheadLabel(d.date)}</span>
              <span className="sub">{d.rest ? 'rest day' : d.plans.map(x => `${model.habits.get(x.habitId)?.name ?? ''} · ${reasonOf(x.reason)}`).join(', ')}</span></span>
            <span className="end">{I.chev()}</span>
          </button>
        ))}</div>}
        <button type="button" className="add" data-a="ahead-add" onClick={() => setAhead(addDays(today, 1))}>{I.plus()}Plan a day ahead</button>
      </div>
      <div className="group">
        <div className="eb"><span>The day's shape · reminder text</span></div>
        <div className="shape-cards">
          <div className="shape-card"><span className="between"><span className="nm">Weekday</span><span className="sub">{shapes.weekday.steps.length} steps</span></span><MiniStrip shape={shapes.weekday} /></div>
          <div className="shape-card"><span className="between"><span className="nm">Weekend</span><span className="sub">{shapes.weekend.steps.length} steps</span></span><MiniStrip shape={shapes.weekend} /></div>
        </div>
      </div>
    </>
  );

  const editor = (editing !== undefined || (wide && chosen)) && (
    <Editor key={`${chosen?.id ?? newId}-${resetAt}`} habit={chosen} newId={newId} today={today} focusFull={filled >= 3}
      onSaved={() => setEditing(undefined)} onCancel={cancel} store={store} model={model} />
  );

  return (
    <>
      <div className="scr scr-3 dotgrid" style={{ gridTemplateColumns: '340px minmax(0,1fr) 340px' }}>
        <aside className="col">{list}</aside>
        <main className="col wide-only">{wide && editor && <div className="panel panel--hero" style={{ padding: '26px 28px' }}>{editor}</div>}</main>
        <aside className="col side wide-only"><p className="meta" style={{ margin: '0 4px' }}>{PLAN_WORDS.nudge}</p></aside>
      </div>
      {ahead !== undefined && (
        <Layer>
          <AheadSheet days={days} start={ahead} model={model} store={store} onClose={() => setAhead(undefined)} />
        </Layer>
      )}
      {!wide && editing !== undefined && (
        <Layer>
          <div className="scrim" data-a="plan-x" onClick={cancel} />
          <div className="sheet" role="dialog" aria-label="Edit habit"><div className="grab" />{editor}</div>
        </Layer>
      )}
    </>
  );
}

/**
 * Plan a day ahead: the whole day as rest, or Focus habits marked off one at a time, with how many of
 * the month's two rest days are free. Saved before the day begins, so it is judged in advance (D-31).
 */
function AheadSheet(p: {
  readonly days: readonly DayAhead[]; readonly start: LocalDate;
  readonly model: NonNullable<ReturnType<typeof useModel>>; readonly store: ReturnType<typeof useApp>['store'];
  onClose(): void;
}) {
  const first = p.days.find(d => d.date === p.start) ?? p.days[0];
  const [date, setDate] = useState(first?.date ?? p.start);
  const [rest, setRest] = useState(first?.rest ?? false);
  const [on, setOn] = useState<ReadonlySet<string>>(() => new Set(first?.plans.map(x => x.habitId)));
  const [reason, setReason] = useState<PlannedReason | undefined>(undefined);
  const [note, setNote] = useState<{ readonly title: string; readonly text: string } | undefined>(undefined);
  const day = p.days.find(d => d.date === date);
  if (!day) return null;
  const pick = (d: DayAhead) => { setDate(d.date); setRest(d.rest); setOn(new Set(d.plans.map(x => x.habitId))); setNote(undefined); };
  const toggle = (id: string) => setOn(prev => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
  });
  const restOpen = day.rest || day.counted || day.left > 0;
  const habits = focusOn(p.model, date);
  const run = async (write: (c: RecordCore) => Promise<Result<void>>) => {
    try {
      const result = await p.store.run(write);
      setNote(resultWords(result));
      return result.kind === 'Saved';
    } catch {
      setNote(NOT_SAVED);
      return false;
    }
  };
  const save = async () => {
    const was = new Set(day.plans.map(x => x.habitId));
    const plans = rest ? [] : [...on].filter(id => !was.has(id)).map(habitId => ({ habitId, reason: reason ?? 'chose' }));
    const unplan = rest ? [] : [...was].filter(id => !on.has(id));
    let ok = true;
    for (const habitId of unplan) if (ok) ok = await run(c => clearObservation(c, { habitId, date }));
    if (ok && (plans.length > 0 || rest !== day.rest)) ok = await run(c => planDay(c, { date, plans, ...(rest !== day.rest && { restDay: rest }) }));
    if (ok) p.onClose();
  };
  return (
    <>
      <div className="scrim" data-a="ahead-x" onClick={p.onClose} />
      <div className="sheet" role="dialog" aria-label="Plan a day ahead">
        <div className="grab" />
        <p className="eb">Planned ahead</p>
        <h2 className="t-l" style={{ margin: '8px 0 8px' }}>{aheadLabel(date)}</h2>
        <div className="opts four" style={{ marginTop: 10 }}>
          {p.days.map(d => <button key={d.date} type="button" className={`opt${d.date === date ? ' on' : ''}`} data-a="ahead-pick" data-x={d.date} onClick={() => pick(d)}>{aheadChip(d.date)}</button>)}
        </div>
        <p className="body" data-a="ahead-words" style={{ margin: '16px 0 14px' }}>{aheadWords(day, monthOf(date))}</p>
        <div className="rows">
          <button type="button" className="row" data-s={rest ? 'planned' : ''} data-a="ahead-rest" disabled={!restOpen} onClick={() => setRest(!rest)}>
            <span className="dot" /><span><span className="nm">The whole day as rest</span><span className="sub">a marked square in Look back</span></span>
            <span className={`toggle${rest ? ' on' : ''}`} aria-hidden="true" />
          </button>
          {!rest && habits.map(h => (
            <button key={h.id} type="button" className="row" data-s={on.has(h.id) ? 'planned' : ''} data-a="ahead-habit" data-x={h.id} onClick={() => toggle(h.id)}>
              <span className="dot" /><span><span className="nm">{h.name}</span><span className="sub">{h.sub}</span></span>
              <span className={`toggle${on.has(h.id) ? ' on' : ''}`} aria-hidden="true" />
            </button>
          ))}
        </div>
        {!rest && habits.length > 0 && (
          <>
            <p className="eb" style={{ margin: '20px 4px 10px' }}>A reason, if you like</p>
            <div className="opts four" style={{ marginTop: 0 }}>
              {REASONS.map(([k, label]) => (
                <button key={k} type="button" className={`opt${reason === k ? ' on' : ''}`} data-a="reason" data-x={k} onClick={() => setReason(reason === k ? undefined : k)}>{label}</button>
              ))}
            </div>
          </>
        )}
        {note && <div className="panel note" style={{ marginTop: 12 }}><p className="eb">{note.title}</p><p className="body" style={{ margin: '8px 0 0' }}>{note.text}</p></div>}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginTop: 22 }}>
          <button type="button" className="btn btn--secondary" data-a="ahead-x" onClick={p.onClose}>Leave it</button>
          <button type="button" className="btn btn--primary" data-a="ahead-ok" onClick={() => void save()}>Plan it</button>
        </div>
      </div>
    </>
  );
}

function Editor(p: {
  readonly habit: HabitRecord | undefined; readonly newId: string; readonly today: string; readonly focusFull: boolean;
  readonly store: ReturnType<typeof useApp>['store']; readonly model: NonNullable<ReturnType<typeof useModel>>;
  onSaved(): void; onCancel(): void;
}) {
  const { habit, today, store, model } = p;
  const [form, setForm] = useState<HabitForm>(habit ? formOf(habit, today) : EMPTY_FORM);
  const [note, setNote] = useState<{ readonly title: string; readonly text: string } | undefined>(undefined);
  const [problems, setProblems] = useState<string[]>([]);
  const [cueAt, setCueAt] = useState('');
  const set = (patch: Partial<HabitForm>) => setForm({ ...form, ...patch });
  const run = async (write: (c: RecordCore) => Promise<Result<void>>) => {
    try {
      const result = await store.run(write);
      setNote(resultWords(result));
      return result.kind === 'Saved';
    } catch {
      setNote(NOT_SAVED);
      return false;
    }
  };
  const save = async () => {
    const { boundary } = model.settings;
    const wrong = formProblems(form, boundary);
    setProblems(wrong);
    if (wrong.length) return;
    const ok = habit ? await run(c => editHabit(c, changeOf(form, habit, boundary))) : await run(c => createHabit(c, newHabitOf(form, p.newId, boundary)));
    if (ok) p.onSaved();
  };
  const bringBack = async () => {
    if (!habit) return;
    try {
      const result = await store.run(c => returnHabit(c, { id: habit.id }));
      if (result.kind !== 'Saved') { setNote(resultWords(result)); return; }
      set({ tier: result.value.into });
      setNote(result.value.focusFull ? { title: 'Back in Log', text: PLAN_WORDS.backInLog } : undefined);
    } catch {
      setNote(NOT_SAVED);
    }
  };
  const cues = habit ? [...model.cues.values()].filter(c => c.habitId === habit.id) : [];
  const retired = habit !== undefined && habit.periods.at(-1)?.until !== undefined;
  const isFocus = form.tier === 'focus';

  return (
    <div data-a="editor">
      <p className="eb">{habit ? 'Editing' : 'New in Log'}</p>
      <h2 className="t-l" style={{ margin: '6px 0 20px' }}>{habit ? habit.name : 'Something new'}</h2>
      <div className="fgrp"><label className="eb field-l" htmlFor="h-name">Name</label>
        <input id="h-name" className="inp" value={form.name} maxLength={60} onChange={e => set({ name: e.currentTarget.value })} /></div>
      <div className="fgrp"><label className="eb field-l">What gets recorded</label>
        <div className="seg" style={{ flexWrap: 'wrap' }}>
          {KINDS.map(([k, label]) => <button key={k} type="button" data-a="kind" data-x={k} className={form.kind === k ? 'on' : ''} disabled={habit !== undefined && form.kind !== k} onClick={() => set({ kind: k })}>{label}</button>)}
        </div>
        <p className="meta" style={{ margin: '2px 4px 0' }}>{PLAN_WORDS.recorded}{habit ? ' What gets recorded stays as it began.' : ''}</p></div>
      {form.kind === 'time' && (
        <div className="fgrp"><label className="eb field-l" htmlFor="h-band">Counts as done by</label>
          <input id="h-band" className="inp" type="time" value={form.band !== undefined ? hm(form.band) : ''} onChange={e => set({ band: fromHm(e.currentTarget.value) })} /></div>
      )}
      {form.kind === 'time' && (
        <div className="fgrp"><label className="eb field-l" htmlFor="h-part">Counts as partly by</label>
          <input id="h-part" className="inp" type="time" value={form.part !== undefined ? hm(form.part) : ''} onChange={e => set({ part: fromHm(e.currentTarget.value) })} />
          <p className="meta" style={{ margin: '2px 4px 0' }}>It can be left empty.</p></div>
      )}
      {form.kind === 'min' && (
        <>
          <div className="fgrp"><label className="eb field-l" htmlFor="h-bar">Counts as done from (minutes)</label>
            <input id="h-bar" className="inp" type="number" min={1} value={form.bar ?? ''} onChange={e => set({ bar: e.currentTarget.value ? Number(e.currentTarget.value) : undefined })} />
            <p className="meta" style={{ margin: '2px 4px 0' }}>The bar is showing up. The aim is not the bar.</p></div>
          <div className="fgrp"><label className="eb field-l" htmlFor="h-aim">Aim (minutes)</label>
            <input id="h-aim" className="inp" type="number" min={1} value={form.aim ?? ''} onChange={e => set({ aim: e.currentTarget.value ? Number(e.currentTarget.value) : undefined })} /></div>
        </>
      )}
      {form.kind === 'count' && (
        <div className="fgrp"><label className="eb field-l" htmlFor="h-bar">Counts as done from</label>
          <input id="h-bar" className="inp" type="number" min={1} max={999} value={form.bar ?? ''} onChange={e => set({ bar: e.currentTarget.value ? Number(e.currentTarget.value) : undefined })} /></div>
      )}
      <div className="fgrp"><label className="eb field-l">Days</label>
        <div className="days">{LETTERS.map((x, i) => {
          const d = i as Weekday, on = form.days.includes(d);
          return <button key={i} type="button" className={on ? 'on' : ''} aria-pressed={on} onClick={() => set({ days: on ? form.days.filter(v => v !== d) : [...form.days, d] })}>{x}</button>;
        })}</div></div>
      <div className="fgrp"><label className="eb field-l">Asked</label>
        <div className="seg"><button type="button" className={form.asked === 'morning' ? 'on' : ''} onClick={() => set({ asked: 'morning' })}>In the morning</button>
          <button type="button" className={form.asked === 'evening' ? 'on' : ''} onClick={() => set({ asked: 'evening' })}>At night</button></div>
        {form.fromTomorrow && <p className="meta" data-a="from-tomorrow" style={{ margin: '2px 4px 0' }}>{PLAN_WORDS.fromTomorrow}</p>}</div>
      {habit && (
        <div className="fgrp"><label className="eb field-l">Reminders</label>
          <div className="list">
            {cues.map(c => (
              <div key={c.id} className="li" data-a="cue">
                <span><span className="nm">{'at' in c.times ? c.times.at.map(hm).join(', ') : `every ${c.times.every} min, ${hm(c.times.from)} – ${hm(c.times.to)}`}</span>
                  <span className="sub">{c.private ? 'shows only "Daily Commit"' : `"${c.text}"`}</span></span>
                <span style={{ display: 'flex', gap: 4 }}>
                  <button type="button" className={`toggle${c.private ? ' on' : ''}`} data-a="keep" aria-label="Keep private" onClick={() => void run(x => saveCue(x, { id: c.id, habitId: c.habitId, kind: c.kind, text: c.text, times: c.times, fade: c.fade, enabled: c.enabled, private: !c.private }))} />
                  <button type="button" className="btn btn--text" data-a="cue-x" onClick={() => void run(x => deleteCue(x, { id: c.id }))}>Remove</button>
                </span>
              </div>
            ))}
            <div className="li"><span><span className="nm">{cues.length ? 'Add another' : 'Add a reminder'}</span><span className="sub">a time of day</span></span>
              <span style={{ display: 'flex', gap: 4 }}><input className="inp cue-time" type="time" aria-label="Reminder time" value={cueAt} onChange={e => setCueAt(e.currentTarget.value)} />
                <button type="button" className="btn btn--text" data-a="cue-add" onClick={() => {
                  const at = fromHm(cueAt);
                  if (at === undefined) return;
                  void run(x => saveCue(x, { id: x.newId(), habitId: habit.id, kind: 'cue', text: habit.name, times: { at: [at] }, enabled: true, private: false })).then(ok => { if (ok) setCueAt(''); });
                }}>{I.plus()}</button></span></div>
          </div>
          <p className="meta" style={{ margin: '2px 4px 0' }}>{cues.some(c => c.private) ? PLAN_WORDS.privateOn : PLAN_WORDS.privateOff} {PLAN_WORDS.nudge}</p></div>
      )}
      <div className="fgrp"><label className="eb field-l">Tier</label>
        {habit
          ? <div className="seg"><button type="button" data-a="tier" data-x="focus" className={isFocus ? 'on' : ''} disabled={!isFocus && p.focusFull} onClick={() => { if (!isFocus) void run(c => swapFocus(c, { into: habit.id })).then(ok => { if (ok) set({ tier: 'focus' }); }); }}>Focus</button>
              <button type="button" data-a="tier" data-x="log" className={isFocus ? '' : 'on'} onClick={() => { if (isFocus) void run(c => swapFocus(c, { out: habit.id })).then(ok => { if (ok) set({ tier: 'log' }); }); }}>Log</button></div>
          : <div className="seg"><button type="button" data-a="tier" data-x="focus" className={isFocus ? 'on' : ''} disabled={p.focusFull} onClick={() => set({ tier: 'focus' })}>Focus</button>
              <button type="button" data-a="tier" data-x="log" className={isFocus ? '' : 'on'} onClick={() => set({ tier: 'log' })}>Log</button></div>}
        <p className="meta" style={{ margin: '2px 4px 0' }}>{isFocus ? PLAN_WORDS.focus : PLAN_WORDS.log}</p></div>
      {habit && (
        <div className="fgrp"><div className="hold">
          <span><span className="body" style={{ display: 'block', color: 'var(--ink-1)' }}>{retired ? `Bring back ${habit.name.toLowerCase()}` : `Retire ${habit.name.toLowerCase()}`}</span><span className="meta">{PLAN_WORDS.retire}</span></span>
          <button type="button" className="btn btn--secondary hold-btn" data-a={retired ? 'return' : 'retire'}
            onClick={() => { if (retired) void bringBack(); else void run(c => retireHabit(c, { id: habit.id })); }}>{retired ? 'Bring back' : 'Retire'}</button>
        </div></div>
      )}
      {problems.length > 0 && <div className="panel note" data-a="form-problems" style={{ marginTop: 12 }}><p className="body" style={{ margin: 0 }}>{problems.join(' ')}</p></div>}
      {note && <div className="panel note" style={{ marginTop: 12 }}><p className="eb">{note.title}</p><p className="body" style={{ margin: '8px 0 0' }}>{note.text}</p></div>}
      <div className="actions" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginTop: 18 }}>
        <button type="button" className="btn btn--secondary" data-a="plan-x" onClick={p.onCancel}>Cancel</button>
        <button type="button" className="btn btn--primary" data-a="plan-save" onClick={() => void save()}>Save</button>
      </div>
    </div>
  );
}
