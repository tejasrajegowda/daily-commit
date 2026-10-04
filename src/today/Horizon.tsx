import type { CSSProperties } from 'react';
import { position, type DayShape } from '../rules/dayLine.ts';
import type { ClockMinute } from '../rules/types.ts';

// The horizon: the day's blocks on one line, lit where the time is, with a bead in its block for each
// thing marked today. It only draws.

const TICKS = [360, 540, 720, 900, 1080, 1260];

export interface HorizonProps {
  readonly shape: DayShape;
  readonly t: ClockMinute;
  /** clock times things were marked today, with the id of the row */
  readonly marks: readonly (readonly [string, ClockMinute])[];
  readonly fresh?: string;
  readonly wideLabels: boolean;
  readonly setting?: boolean;
  readonly boundary: ClockMinute;
}

const vars = (v: Record<string, string>) => v as CSSProperties;

export function Horizon(p: HorizonProps) {
  const X = (m: ClockMinute) => position(p.shape, m);
  const when = (p.t >= p.shape.lightsOut || p.t < p.boundary ? ' is-late' : p.t < p.shape.window.from + 45 ? ' is-early' : '') + (p.setting ? ' setting' : '');
  return (
    <div className={`hz${when}`} style={vars({ '--now': `${X(p.t).toFixed(2)}%` })} aria-hidden="true">
      <div className="hz-sun" />
      <div className="hz-ground" />
      {p.wideLabels && p.shape.blocks.map(b => {
        const on = p.t >= b.start && p.t < b.end, L = X(b.start), W = X(b.end) - L, c = L + W / 2;
        return <span key={`l${b.start}`} className={`hz-lbl${on ? ' is-now' : ''}${c < 9 ? ' l' : c > 91 ? ' r' : ''}`} style={{ left: `${c < 9 ? L : c > 91 ? L + W : c}%` }}>{b.label}</span>;
      })}
      <div className="hz-strip">
        {p.shape.blocks.map(b => {
          const on = p.t >= b.start && p.t < b.end, L = X(b.start), W = X(b.end) - L;
          // each block shows its own slice of one strip-wide pool of light centred on "now"
          const bs = `${((100 / W) * 100).toFixed(3)}%`, bx = `${((L / (100 - W)) * 100).toFixed(3)}%`;
          return (
            <i key={b.start} className={`hz-blk${on ? ' is-now' : ''}`} style={vars({ left: `${L}%`, width: `${W}%`, '--bs': bs, '--bx': bx })}>
              {p.marks.filter(([, m]) => m >= b.start && m < b.end).map(([id, m]) => (
                <i key={id} className={`hz-bead${id === p.fresh ? ' fresh' : ''}`} style={{ left: `${(((X(m) - L) / W) * 100).toFixed(2)}%` }} />
              ))}
            </i>
          );
        })}
      </div>
      <i className="hz-lo" style={{ left: `${X(p.shape.lightsOut)}%` }} />
      <i className="hz-now" />
      {TICKS.map(k => <span key={k} className="hz-tick" style={{ left: `${X(k)}%` }}>{String(k / 60).padStart(2, '0')}</span>)}
    </div>
  );
}
