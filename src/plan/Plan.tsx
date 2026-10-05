import { useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { resultWords, shapesOf, useApp, useModel, useNav, useToday } from '../app/context.ts';
import type { HabitRecord } from '../record/model.ts';
import { deleteCue, saveCue } from '../record/ops/cues.ts';
import { createHabit, editHabit, retireHabit, returnHabit, swapFocus } from '../record/ops/habits.ts';
import type { Result } from '../record/results.ts';
import type { RecordCore } from '../record/core.ts';
import { position, type DayShape } from '../rules/dayLine.ts';
import type { Weekday } from '../rules/types.ts';
import { I } from '../ui/icons.tsx';
import { useWide } from '../ui/useWide.ts';
import { changeOf, EMPTY_FORM, formOf, formProblems, habitLine, newHabitOf, PLAN_WORDS, planLists, slotNote, type HabitForm } from './planView.ts';

// Plan: Focus as three slots, Log beside it, the day's shapes, and the editor. On a phone the
// editor is a sheet; on a laptop it is the middle panel. A habit's kind is fixed once it exists.

const LETTERS = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];
const KINDS = [['time', 'A time'], ['tri', 'Did / partly'], ['min', 'Minutes'], ['count', 'A count']] as const;
const hm = (m: number) => `${String(Math.floor(m / 60) % 24).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
const fromHm = (s: string) => { const m = /^(\d{1,2}):(\d{2})$/.exec(s); return m ? Number(m[1]) * 60 + Number(m[2]) : undefined; };

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
  if (!model || !today) return null;
  const lists = planLists(model, today);
  const shapes = shapesOf(model.settings);
  const chosen = editing === 'new' ? undefined : editing ? model.habits.get(editing) : wide ? lists.focus.find(Boolean) ?? lists.log[0] : undefined;
  const filled = lists.focus.filter(Boolean).length;
  const open = (id: string | 'new') => setEditing(id);

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
    <Editor key={chosen?.id ?? newId} habit={chosen} newId={newId} today={today} focusFull={filled >= 3}
      onDone={() => setEditing(undefined)} store={store} model={model} />
  );

  return (
    <>
      <div className="scr scr-3 dotgrid" style={{ gridTemplateColumns: '340px minmax(0,1fr) 340px' }}>
        <aside className="col">{list}</aside>
        <main className="col wide-only">{wide && editor && <div className="panel panel--hero" style={{ padding: '26px 28px' }}>{editor}</div>}</main>
        <aside className="col side wide-only"><p className="meta" style={{ margin: '0 4px' }}>{PLAN_WORDS.nudge}</p></aside>
      </div>
      {!wide && editing !== undefined && (
        <Layer>
          <div className="scrim" data-a="plan-x" onClick={() => setEditing(undefined)} />
          <div className="sheet" role="dialog" aria-label="Edit habit"><div className="grab" />{editor}</div>
        </Layer>
      )}
    </>
  );
}

function Editor(p: {
  readonly habit: HabitRecord | undefined; readonly newId: string; readonly today: string; readonly focusFull: boolean;
  readonly store: ReturnType<typeof useApp>['store']; readonly model: NonNullable<ReturnType<typeof useModel>>; onDone(): void;
}) {
  const { habit, today, store, model } = p;
  const [form, setForm] = useState<HabitForm>(habit ? formOf(habit, today) : EMPTY_FORM);
  const [note, setNote] = useState<{ readonly title: string; readonly text: string } | undefined>(undefined);
  const [problems, setProblems] = useState<string[]>([]);
  const [cueAt, setCueAt] = useState('');
  const set = (patch: Partial<HabitForm>) => setForm({ ...form, ...patch });
  const run = async (write: (c: RecordCore) => Promise<Result<void>>) => {
    const result = await store.run(write);
    setNote(resultWords(result));
    return result.kind === 'Saved';
  };
  const save = async () => {
    const wrong = formProblems(form);
    setProblems(wrong);
    if (wrong.length) return;
    const ok = habit ? await run(c => editHabit(c, changeOf(form, habit))) : await run(c => createHabit(c, newHabitOf(form, p.newId)));
    if (ok) p.onDone();
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
          {KINDS.map(([k, label]) => <button key={k} type="button" className={form.kind === k ? 'on' : ''} disabled={habit !== undefined && form.kind !== k} onClick={() => set({ kind: k })}>{label}</button>)}
        </div>
        <p className="meta" style={{ margin: '2px 4px 0' }}>{PLAN_WORDS.recorded}{habit ? ' What gets recorded stays as it began.' : ''}</p></div>
      {form.kind === 'time' && (
        <div className="fgrp"><label className="eb field-l" htmlFor="h-band">Counts as done by</label>
          <input id="h-band" className="inp" type="time" value={form.band !== undefined ? hm(form.band) : ''} onChange={e => set({ band: fromHm(e.currentTarget.value) })} /></div>
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
      <div className="fgrp"><label className="eb field-l">Days</label>
        <div className="days">{LETTERS.map((x, i) => {
          const d = i as Weekday, on = form.days.includes(d);
          return <button key={i} type="button" className={on ? 'on' : ''} aria-pressed={on} onClick={() => set({ days: on ? form.days.filter(v => v !== d) : [...form.days, d] })}>{x}</button>;
        })}</div></div>
      <div className="fgrp"><label className="eb field-l">Asked</label>
        <div className="seg"><button type="button" className={form.asked === 'morning' ? 'on' : ''} onClick={() => set({ asked: 'morning' })}>In the morning</button>
          <button type="button" className={form.asked === 'evening' ? 'on' : ''} onClick={() => set({ asked: 'evening' })}>At night</button></div></div>
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
              <span style={{ display: 'flex', gap: 4 }}><input className="inp" type="time" aria-label="Reminder time" value={cueAt} onChange={e => setCueAt(e.currentTarget.value)} style={{ minHeight: 36 }} />
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
          ? <div className="seg"><button type="button" className={isFocus ? 'on' : ''} disabled={!isFocus && p.focusFull} onClick={() => { if (!isFocus) void run(c => swapFocus(c, { into: habit.id })); }}>Focus</button>
              <button type="button" className={isFocus ? '' : 'on'} onClick={() => { if (isFocus) void run(c => swapFocus(c, { out: habit.id })); }}>Log</button></div>
          : <div className="seg"><button type="button" className={isFocus ? 'on' : ''} disabled={p.focusFull} onClick={() => set({ tier: 'focus' })}>Focus</button>
              <button type="button" className={isFocus ? '' : 'on'} onClick={() => set({ tier: 'log' })}>Log</button></div>}
        <p className="meta" style={{ margin: '2px 4px 0' }}>{isFocus ? PLAN_WORDS.focus : PLAN_WORDS.log}</p></div>
      {habit && (
        <div className="fgrp"><div className="hold">
          <span><span className="body" style={{ display: 'block', color: 'var(--ink-1)' }}>{retired ? `Bring back ${habit.name.toLowerCase()}` : `Retire ${habit.name.toLowerCase()}`}</span><span className="meta">{PLAN_WORDS.retire}</span></span>
          <button type="button" className="btn btn--secondary" data-a={retired ? 'return' : 'retire'} style={{ minHeight: 40 }}
            onClick={() => void run(c => (retired ? returnHabit(c, { id: habit.id }) : retireHabit(c, { id: habit.id })))}>{retired ? 'Bring back' : 'Retire'}</button>
        </div></div>
      )}
      {problems.length > 0 && <div className="panel note" data-a="form-problems" style={{ marginTop: 12 }}><p className="body" style={{ margin: 0 }}>{problems.join(' ')}</p></div>}
      {note && <div className="panel note" style={{ marginTop: 12 }}><p className="eb">{note.title}</p><p className="body" style={{ margin: '8px 0 0' }}>{note.text}</p></div>}
      <div className="actions" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginTop: 18 }}>
        <button type="button" className="btn btn--secondary" data-a="plan-x" onClick={p.onDone}>Cancel</button>
        <button type="button" className="btn btn--primary" data-a="plan-save" onClick={() => void save()}>Save</button>
      </div>
    </div>
  );
}
