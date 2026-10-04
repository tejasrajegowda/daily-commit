import type { Trend as TrendData } from './lookView.ts';

// The wake-time trend: each recorded time as a dot, the aim as a faint band (never a line to fall
// short of), and from day 21 a smooth line through each week's middle.

const MON3 = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const hm = (m: number) => `${String(Math.floor(m / 60) % 24).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

export interface TrendProps {
  readonly data: TrendData;
  /** the first day's date, for the month labels */
  readonly start: string;
  /** the aim as a band of clock times */
  readonly band?: { readonly from: number; readonly to: number };
  readonly w: number;
  readonly h: number;
}

export function Trend({ data, start, band, w, h }: TrendProps) {
  const lo = Math.min(345, ...data.dots.map(d => d.minute)) , hi = Math.max(480, ...data.dots.map(d => d.minute));
  const y0 = Math.floor(lo / 15) * 15, y1 = Math.ceil(hi / 15) * 15;
  const n = data.days;
  const px = (i: number) => 28 + (i / Math.max(1, n - 1)) * (w - 36);
  const py = (m: number) => 8 + ((Math.min(y1, Math.max(y0, m)) - y0) / (y1 - y0)) * (h - 30);
  const startMs = Date.parse(`${start}T00:00:00Z`);
  const months: { i: number; label: string }[] = [];
  for (let i = 0; i < n; i++) {
    const d = new Date(startMs + i * 86_400_000);
    if (i === 0 || d.getUTCDate() === 1) months.push({ i, label: MON3[d.getUTCMonth()] ?? '' });
  }
  const pts = data.line.map(p => [px(p.day), py(p.minute)] as const);
  let path = pts.length ? `M${pts[0]![0].toFixed(1)},${pts[0]![1].toFixed(1)}` : '';
  for (let k = 0; k < pts.length - 1; k++) {
    const p0 = pts[Math.max(0, k - 1)]!, p1 = pts[k]!, p2 = pts[k + 1]!, p3 = pts[Math.min(pts.length - 1, k + 2)]!;
    const c1 = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6], c2 = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6];
    path += ` C${c1[0]!.toFixed(1)},${c1[1]!.toFixed(1)} ${c2[0]!.toFixed(1)},${c2[1]!.toFixed(1)} ${p2[0].toFixed(1)},${p2[1].toFixed(1)}`;
  }
  const grid = [y0 + 15, Math.round((y0 + y1) / 30) * 15, y1 - 15].filter((m, i, a) => a.indexOf(m) === i);
  return (
    <svg className="trend" viewBox={`0 0 ${w} ${h}`} role="img" aria-label="Recorded times">
      {band && <rect x="28" y={py(band.from)} width={w - 36} height={Math.max(2, py(band.to) - py(band.from))} fill="color-mix(in oklab,var(--a09) 9%,transparent)" rx="4" />}
      {grid.map(m => (
        <g key={m}><text x="0" y={py(m) + 4}>{hm(m)}</text><line x1="28" x2={w - 8} y1={py(m)} y2={py(m)} stroke="rgb(var(--lift)/.07)" /></g>
      ))}
      {months.map(m => <text key={m.i} x={px(m.i)} y={h - 4}>{m.label}</text>)}
      {data.dots.map(d => (
        <circle key={d.day} cx={px(d.day)} cy={py(d.minute)} r={n > 60 ? 2 : 3} fill={band && d.minute <= band.to ? 'var(--a10)' : 'rgb(var(--lift)/.35)'} />
      ))}
      {path && <path d={path} fill="none" stroke="var(--a09)" strokeWidth="2" strokeLinecap="round" />}
    </svg>
  );
}
