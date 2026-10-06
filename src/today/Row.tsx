import { useState, type ReactNode } from 'react';
import type { TriValue } from '../rules/types.ts';
import { dur, fromHm, hm, type TodayRow } from './todayView.ts';
import { clockOfDay } from '../rules/clock.ts';

// One row of Today. A tap on a time row with nothing in it records now, unless the row asks for its
// time; any other tap opens its choices. It only draws and reports what was tapped.

export type RowAction =
  | { readonly kind: 'tap' }
  | { readonly kind: 'set'; readonly value: number | TriValue }
  | { readonly kind: 'add'; readonly by: number }
  | { readonly kind: 'nudge'; readonly minutes: number }
  | { readonly kind: 'now' }
  /** a clock time typed in, for a row that asks for its time */
  | { readonly kind: 'at'; readonly clock: number }
  | { readonly kind: 'clear' };

export interface RowProps {
  readonly row: TodayRow;
  readonly open: boolean;
  readonly fresh: boolean;
  /** "now" shown in the subline while this row's block is under way */
  readonly sub?: string;
  readonly showKey?: boolean;
  /** a time row that asks for its time when opened, instead of offering now and nudges */
  readonly ask?: boolean;
  onAction(action: RowAction): void;
}

const STATE: Record<string, string> = { did: 'did', partly: 'partly', planned: 'planned' };

export function Row({ row, open, fresh, sub, showKey = true, ask = false, onAction }: RowProps) {
  const { habit, value } = row;
  if (habit.kind === 'mood') {
    return (
      <div className="row mood-row">
        <span><span className="nm">{habit.name}</span></span>
        <span className="mood">
          {[1, 2, 3, 4, 5].map(k => (
            <button key={k} type="button" className={value === k ? 'on' : ''} data-a="mood" data-x={k} aria-label={`mood ${k}`}
              onClick={() => onAction(value === k ? { kind: 'clear' } : { kind: 'set', value: k })}>{k}</button>
          ))}
        </span>
      </div>
    );
  }
  const state = row.planned && value === undefined ? 'planned' : STATE[row.state] ?? '';
  let val: ReactNode = null;
  if (state === 'planned') val = <span className="q">planned rest</span>;
  else if (habit.kind === 'time') val = typeof value === 'number' ? hm(clockOfDay(value)) : <span className="q">—</span>;
  else if (habit.kind === 'min') val = typeof value === 'number' ? dur(value) : <span className="q">— min</span>;
  else if (habit.kind === 'count') val = typeof value === 'number' ? String(value) : <span className="q">—</span>;
  else if (value === 'partly') val = <span className="q">partly</span>;
  else if (value === 'not') val = <span className="q">not today</span>;

  let opts: ReactNode = null;
  if (open && habit.kind === 'tri') {
    opts = (
      <div className="opts">
        {([['did', 'Did it'], ['partly', 'Partly'], ['not', 'Not today']] as const).map(([k, label]) => (
          <button key={k} type="button" className={`opt${value === k ? ' on' : ''}`} data-a="opt" data-x={`${habit.id}:${k}`}
            onClick={() => onAction(value === k ? { kind: 'clear' } : { kind: 'set', value: k })}>{label}</button>
        ))}
      </div>
    );
  }
  if (open && habit.kind === 'min') {
    opts = (
      <div className="opts four">
        {([[15, '+15m'], [30, '+30m'], [60, '+1h']] as const).map(([m, label]) => (
          <button key={m} type="button" className="opt" data-a="addmin" data-x={`${habit.id}:${m}`} onClick={() => onAction({ kind: 'add', by: m })}>{label}</button>
        ))}
        <button type="button" className="opt" data-a="clear" data-x={habit.id} onClick={() => onAction({ kind: 'clear' })}>Clear</button>
      </div>
    );
  }
  if (open && habit.kind === 'count') {
    opts = (
      <div className="opts">
        <button type="button" className="opt" data-a="addcount" data-x={`${habit.id}:-1`} onClick={() => onAction({ kind: 'add', by: -1 })}>−1</button>
        <button type="button" className="opt" data-a="addcount" data-x={`${habit.id}:1`} onClick={() => onAction({ kind: 'add', by: 1 })}>+1</button>
        <button type="button" className="opt" data-a="clear" data-x={habit.id} onClick={() => onAction({ kind: 'clear' })}>Clear</button>
      </div>
    );
  }
  if (open && habit.kind === 'time' && ask) {
    opts = <TimeAsk key={String(value)} id={habit.id} value={typeof value === 'number' ? value : undefined} onAction={onAction} />;
  } else if (open && habit.kind === 'time') {
    opts = (
      <div className="opts four">
        <button type="button" className="opt" data-a="nudge" data-x={`${habit.id}:-5`} onClick={() => onAction({ kind: 'nudge', minutes: -5 })}>−5m</button>
        <button type="button" className="opt" data-a="nudge" data-x={`${habit.id}:5`} onClick={() => onAction({ kind: 'nudge', minutes: 5 })}>+5m</button>
        <button type="button" className="opt" data-a="setnow" data-x={habit.id} onClick={() => onAction({ kind: 'now' })}>Now</button>
        <button type="button" className="opt" data-a="clear" data-x={habit.id} onClick={() => onAction({ kind: 'clear' })}>Clear</button>
      </div>
    );
  }
  return (
    <div className={`row${open ? ' is-open' : ''}${fresh ? ' fresh' : ''}`} data-s={state} data-a="row" data-x={habit.id} role="button" tabIndex={0}
      onClick={e => { if (!(e.target as Element).closest('.opts')) onAction({ kind: 'tap' }); }}
      onKeyDown={e => { if ((e.key === 'Enter' || e.key === ' ') && e.target === e.currentTarget) { e.preventDefault(); onAction({ kind: 'tap' }); } }}>
      <span className="dot" />
      <span><span className="nm">{habit.name}</span><span className="sub">{open && ask ? 'What time was it?' : sub ?? habit.sub}</span></span>
      <span className="val">{val}{showKey && row.key !== undefined && <span className="kbd">{row.key}</span>}</span>
      {opts}
    </div>
  );
}

/** The time typed in for a row that asks for it; nothing is saved until Save (or Enter). */
function TimeAsk({ id, value, onAction }: { readonly id: string; readonly value?: number; onAction(action: RowAction): void }) {
  const [at, setAt] = useState(value !== undefined ? hm(clockOfDay(value)) : '');
  const clock = fromHm(at);
  const save = () => { if (clock !== undefined) onAction({ kind: 'at', clock }); };
  return (
    <div className="opts four">
      <input className="inp" type="time" aria-label="What time was it" data-a="time-at" data-x={id} value={at} autoFocus
        style={{ gridColumn: 'span 2', minHeight: 44 }}
        onChange={e => setAt(e.currentTarget.value)} onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); save(); } }} />
      <button type="button" className="opt" data-a="time-save" data-x={id} disabled={clock === undefined} onClick={save}>Save</button>
      {value !== undefined && <button type="button" className="opt" data-a="clear" data-x={id} onClick={() => onAction({ kind: 'clear' })}>Clear</button>}
    </div>
  );
}
