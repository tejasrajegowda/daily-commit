import { useModel, useToday } from '../app/context.ts';
import { toUtcMs } from '../rules/dates.ts';
import { dayNumber } from '../rules/journey.ts';

// Today. For now the frame: the date, the day number and the heading. The rows, the horizon, the
// evening and the closed day arrive with the Today task.

const DOW = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MON = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

export function longDate(date: string): string {
  const d = new Date(toUtcMs(date));
  return `${DOW[d.getUTCDay()]} ${d.getUTCDate()} ${MON[d.getUTCMonth()]}`;
}

export function Today() {
  const model = useModel();
  const today = useToday();
  if (!model || !today) return null;
  return (
    <div className="scr scr-3 today">
      <main className="col">
        <div className="topline"><span className="eb">{longDate(today)}</span><span className="eb">Day <b>{dayNumber(model.settings.journeyStart, today)}</b></span></div>
        <div className="sky"><div className="here"><h1 className="t-xl">Today</h1></div></div>
      </main>
    </div>
  );
}
