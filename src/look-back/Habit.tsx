import { useMemo } from 'react';
import { useApp, useModel, useNav, useToday } from '../app/context.ts';
import { rulesInput } from '../record/read.ts';
import { datesFrom } from '../rules/dates.ts';
import { dayNumber, hasOpened } from '../rules/journey.ts';
import { lookup, stateOf } from '../rules/state.ts';
import { I } from '../ui/icons.tsx';
import { useWide } from '../ui/useWide.ts';
import { cellClass, numbersOf, trend, unitLine, valueWords } from './lookView.ts';
import { Trend } from './Trend.tsx';

// One habit's page: its last two calendar months, its numbers (which only count up, except the run
// in progress, which is never the headline), and how it is counted.

const MON = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const LETTERS = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];
const hm = (m: number) => `${String(Math.floor(m / 60) % 24).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

export function Habit() {
  const { store } = useApp();
  const { nav, go } = useNav();
  const model = useModel();
  const today = useToday();
  const wide = useWide();
  const revision = store.revision();
  const input = useMemo(() => (model ? rulesInput(model) : undefined), [model, revision]);
  if (!model || !today || !input) return null;
  const habit = model.habits.get(nav.variant) ?? [...model.habits.values()].sort((a, b) => a.order - b.order)[0];
  if (!habit) return null;
  const start = model.settings.journeyStart;
  const n = numbersOf(input, habit, start, today);

  const months = [...new Set(datesFrom(start, today).map(d => d.slice(0, 7)))].slice(-2);
  const cal = (ym: string) => {
    const [y, m] = ym.split('-').map(Number) as [number, number];
    const days = new Date(Date.UTC(y, m, 0)).getUTCDate();
    const lead = (new Date(Date.UTC(y, m - 1, 1)).getUTCDay() + 6) % 7;
    return (
      <div key={ym}>
        <p className="t-m" style={{ margin: '0 0 12px' }}>{MON[m - 1]} {y}</p>
        <div className="cal">
          {LETTERS.map((x, i) => <span key={`d${i}`} className="dn">{x}</span>)}
          {Array.from({ length: lead }, (_, k) => <i key={`n${k}`} className="c na" />)}
          {Array.from({ length: days }, (_, k) => {
            const date = `${ym}-${String(k + 1).padStart(2, '0')}`;
            if (date < start || date > today) return <i key={date} className="c na">{k + 1}</i>;
            const s = stateOf(habit, lookup(input.index, habit.id, date), date);
            return <i key={date} className={`c ${cellClass(s)}${date === today ? ' now' : ''}`} title={valueWords(habit, input, date)}>{k + 1}</i>;
          })}
        </div>
      </div>
    );
  };

  // the run in progress is a headline only while it's 1 or more; at 0 it would be the one number
  // here allowed to go back down, so it drops out and the two numbers that never go down remain (§8 #1, #2)
  const showRun = habit.kind === 'min' || n.currentRun >= 1;
  const numbers = (
    <div className="panel">
      <div style={{ display: 'grid', gridTemplateColumns: showRun ? 'repeat(3,1fr)' : 'repeat(2,1fr)', gap: 12 }}>
        <div><div className="num-xl">{n.did}</div><div className="meta">{habit.kind === 'min' ? 'sessions' : 'all time'}</div></div>
        <div><div className="num-xl">{n.longestRun}</div><div className="meta">longest run</div></div>
        {showRun && <div><div className="num-xl">{habit.kind === 'min' ? Math.round(n.minutes / 60) : n.currentRun}</div><div className="meta">{habit.kind === 'min' ? 'hours in all' : 'this run'}</div></div>}
      </div>
    </div>
  );
  const band = habit.target.band !== undefined ? { from: habit.target.band - 30, to: habit.target.band } : undefined;
  const counted = habit.kind === 'time'
    ? `The app stores the actual time, never a yes or no.${habit.target.band !== undefined ? ` "By ${hm(habit.target.band)}" is the target applied to those times — change it in Plan and every past day is re-read correctly.` : ''}`
    : habit.kind === 'min'
      ? `Minutes are stored as they are. ${habit.target.bar ?? 1} minutes counts as showing up${habit.target.aim ? ` — the ${Math.round(habit.target.aim / 60) >= 1 ? `${Math.round(habit.target.aim / 60)} hour${Math.round(habit.target.aim / 60) > 1 ? 's' : ''}` : `${habit.target.aim} minutes`} are the aim, not the bar` : ''}.`
      : habit.kind === 'mood' ? 'A number from 1 to 5, recorded and never judged.'
        : 'Did it, partly, or not today — and a day nobody answered looks exactly like a day that said not today.';

  return (
    <div className="scr scr-2">
      <main className="col">
        <div className="stack-l">
          <div>
            <button type="button" className="btn btn--text" data-a="nav" data-x="look" style={{ paddingLeft: 0, gap: 4 }} onClick={() => go('look')}>{I.back({ width: 18, height: 18 })}Look back</button>
            <h1 className="t-l" style={{ marginTop: 4 }}>{habit.name}</h1>
            <p className="meta" style={{ margin: '4px 0 0' }}>{habit.sub ? `${habit.sub} · ` : ''}{habit.kind === 'min' ? unitLine(habit, n).replace('sessions · ', '') : `${n.did} ${unitLine(habit, n)}`}</p>
          </div>
          <div className="phone-only">{numbers}</div>
          <div className="panel" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(260px,1fr))', gap: 28 }}>{months.map(cal)}</div>
          <div className="legend" style={{ margin: '-6px 4px 0' }}><span><i className="d" />did it</span><span><i className="p" />partly</span><span><i className="pl" />planned rest</span><span><i />nothing recorded</span></div>
          {habit.kind === 'time' && (
            <div className="panel">
              <div className="panel-h"><span className="eb">Recorded times</span>{!hasOpened('timeTrend', dayNumber(start, today)) && <span className="meta">the line arrives on day 21</span>}</div>
              <Trend data={trend(input, habit, start, today)} start={start} band={band} w={wide ? 620 : 300} h={wide ? 180 : 150} />
            </div>
          )}
        </div>
      </main>
      <aside className="col side wide-only">
        <div className="stack-l">
          {numbers}
          <div className="panel"><p className="eb">How it's counted</p><p className="body" style={{ margin: '10px 0 0', fontSize: 14 }}>{counted}</p></div>
        </div>
      </aside>
    </div>
  );
}
