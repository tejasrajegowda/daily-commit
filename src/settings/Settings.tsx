import { useEffect, useState, type ReactNode } from 'react';
import { displayOf, exportCopy, lastCopyAt, saveDisplay, spaceUsed, useApp, useModel, useNav, type Display, type ExportOutcome } from '../app/context.ts';
import { setSetting } from '../record/ops/settings.ts';
import { applyDisplay } from '../ui/display.ts';
import { I } from '../ui/icons.tsx';
import { useWide } from '../ui/useWide.ts';
import { CATEGORIES, checkinLines, dayLines, SETTINGS_WORDS as W, sizeWords, whenWords, type Category, type Line } from './settingsWords.ts';

// Settings: every group stacked on a phone, a category list beside one panel on a laptop. Support
// is a screen of its own, reached from here, always in the same place.

function Row({ line, end, onClick, a, x }: { readonly line: Line; readonly end?: ReactNode; readonly onClick?: () => void; readonly a?: string; readonly x?: string }) {
  const inner = <><span><span className="nm">{line.nm}</span><span className="sub">{line.sub}</span></span>{end}</>;
  return onClick
    ? <button type="button" className="li" data-a={a} data-x={x} onClick={onClick}>{inner}</button>
    : <div className="li">{inner}</div>;
}
const Toggle = ({ on }: { readonly on: boolean }) => <span className={`toggle${on ? ' on' : ''}`} role="presentation" />;
const Chev = () => <span className="end">{I.chev()}</span>;
const Note = ({ children }: { readonly children: ReactNode }) => <p className="meta" style={{ margin: '10px 4px 0' }}>{children}</p>;

export function Settings() {
  const deps = useApp();
  const { core, store } = deps;
  const model = useModel();
  const { go } = useNav();
  const wide = useWide();
  const [cat, setCat] = useState<Category>('display');
  const [display, setDisplay] = useState<Display | undefined>(undefined);
  const [copyAt, setCopyAt] = useState<number | undefined>(undefined);
  const [space, setSpace] = useState<number | undefined>(undefined);
  const [exported, setExported] = useState<ExportOutcome | undefined>(undefined);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    void Promise.all([displayOf(deps), lastCopyAt(deps), spaceUsed(deps)]).then(([d, at, used]) => {
      if (!live) return;
      setDisplay(d);
      setCopyAt(at);
      setSpace(used);
    });
    return () => { live = false; };
  }, [deps]);

  if (!model) return null;
  const s = model.settings;
  const tz = s.tz;
  const flip = (name: 'cuesOn' | 'paused', on: boolean) => void store.run(c => setSetting(c, name, on));
  const changeDisplay = (next: Display) => {
    setDisplay(next);
    applyDisplay(next);
    void saveDisplay(deps, next);
  };
  const exportNow = async () => {
    setBusy(true);
    setExported(await exportCopy(deps));
    setBusy(false);
  };

  const panels: Record<Category, () => ReactNode> = {
    day: () => {
      const checkins = checkinLines(model.cues.values());
      return (
        <>
          <div className="list">{dayLines(s).map(l => <Row key={l.nm} line={l} />)}</div>
          <p className="eb" style={{ margin: '22px 4px 10px' }}>Check-ins</p>
          <div className="list">
            {checkins.map(l => <Row key={l.nm} line={l} />)}
            <Row line={W.cues} a="cues" end={<Toggle on={s.cuesOn} />} onClick={() => flip('cuesOn', !s.cuesOn)} />
          </div>
          <Note>{checkins.length ? W.cuesNote : W.noCheckins}</Note>
        </>
      );
    },
    display: () => {
      const k = Math.round((display?.contrast ?? 1) * 100);
      return (
        <div className="list">
          <div className="li" style={{ display: 'block', padding: 16 }}>
            <div className="between"><span className="nm">{W.contrast.nm}</span><span className="meta" data-a="contrast-n">{k}</span></div>
            <input className="range" type="range" min={60} max={160} value={k} data-a="contrast" aria-label="Contrast" style={{ ['--pct' as string]: `${k - 60}%`, marginTop: 10 }}
              onChange={e => display && changeDisplay({ ...display, contrast: Number(e.target.value) / 100 })} />
            <span className="sub">{W.contrast.sub}</span>
          </div>
          <Row line={W.dim} a="dim" end={<Toggle on={display?.dim ?? false} />} onClick={() => display && changeDisplay({ ...display, dim: !display.dim })} />
        </div>
      );
    },
    privacy: () => (
      <div className="list">
        <Row line={{ nm: 'Locks the moment you leave', sub: "switching apps, or the screen going off. Picking a file or sharing from inside the app doesn't count" }} />
      </div>
    ),
    data: () => (
      <>
        <div className="list">
          <Row line={W.auto(copyAt === undefined ? undefined : whenWords(copyAt, core.now(), tz))} />
          <Row line={W.android} />
          <Row line={W.export} a="export" end={<Chev />} onClick={busy ? undefined : () => void exportNow()} />
          <Row line={W.restore} a="restore" end={<Chev />} onClick={() => go('restore')} />
          <Row line={W.space(space === undefined ? undefined : sizeWords(space))} />
        </div>
        {exported && <Note><span data-a="exported">{W.exported[exported]}</span></Note>}
        <Note>{W.dataNote}</Note>
      </>
    ),
    pause: () => (
      <>
        <div className="list"><Row line={W.pause} a="pause" end={<Toggle on={s.paused === true} />} onClick={() => flip('paused', s.paused !== true)} /></div>
        <Note>{W.pauseNote}</Note>
      </>
    ),
    support: () => <div className="list"><Row line={W.supportRow} a="support" end={<Chev />} onClick={() => go('support')} /></div>,
    about: () => (
      <>
        <div className="list"><Row line={W.about(deps.appVersion)} /></div>
        <p className="eb" style={{ margin: '22px 4px 10px' }}>What the lock can't do</p>
        <div className="list">{W.cant.map(l => <Row key={l.nm} line={l} />)}</div>
        <Note>{W.aboutNote}</Note>
      </>
    ),
  };

  if (!wide) {
    return (
      <div className="scr settings">
        <main className="col">
          <div className="between"><h1 className="t-l">Settings</h1><button type="button" className="btn btn--text" data-a="done" onClick={() => go('plan')}>Done</button></div>
          <div style={{ marginTop: 18 }}>
            {CATEGORIES.map(([k, label]) => <div key={k} className="set-grp" data-cat={k}><span className="eb">{label}</span>{panels[k]()}</div>)}
          </div>
        </main>
      </div>
    );
  }
  return (
    <div className="scr settings" style={{ gridTemplateColumns: '240px minmax(0,640px)', justifyContent: 'center' }}>
      <aside className="col">
        <h1 className="t-l" style={{ margin: '0 0 18px 4px' }}>Settings</h1>
        {CATEGORIES.map(([k, label]) => (
          <button key={k} type="button" className={`li${cat === k ? ' on' : ''}`} data-a="setcat" data-x={k} style={{ borderRadius: 12, boxShadow: 'none', minHeight: 44 }}
            onClick={() => (k === 'support' ? go('support') : setCat(k))}><span className="nm">{label}</span></button>
        ))}
      </aside>
      <main className="col" style={{ paddingTop: 56 }} data-cat={cat}>
        <p className="eb" style={{ margin: '0 4px 12px' }}>{CATEGORIES.find(c => c[0] === cat)?.[1]}</p>
        {panels[cat]()}
      </main>
    </div>
  );
}
