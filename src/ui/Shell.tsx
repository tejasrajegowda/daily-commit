import type { ReactNode } from 'react';
import { I } from './icons.tsx';

// The app's frame: the rail on a laptop, the dock on a phone, the view between them, and the layer
// above for sheets. The stylesheet decides which bar shows; bare screens (the lock, the first day,
// restore) hide both.

export type Section = 'today' | 'look' | 'diary' | 'plan';

const NAV: readonly (readonly [Section, string, () => ReactNode])[] = [
  ['today', 'Today', I.today], ['look', 'Look back', I.look], ['diary', 'Diary', I.diary], ['plan', 'Plan', I.plan],
];

export interface FrameProps {
  /** the section lit in the bars; undefined on a screen of its own, such as the secret screens */
  readonly section?: Section;
  readonly settingsOn?: boolean;
  /** no bars: the lock, the first day, restore and the secret screens */
  readonly bare?: boolean;
  /** the diary page is being written in: the bars step back */
  readonly writing?: boolean;
  onNav(to: Section | 'settings'): void;
  onLock(): void;
  readonly layer?: ReactNode;
  readonly children: ReactNode;
}

export function Frame(props: FrameProps) {
  const { section, onNav } = props;
  const cls = ['app', props.bare ? 'is-bare' : '', props.writing ? 'is-writing' : ''].filter(Boolean).join(' ');
  return (
    <>
      <div className={cls} id="app">
        <nav className="rail" id="rail" aria-label="Sections">
          <div className="brand" title="Daily Commit">{I.brand()}</div>
          {NAV.map(([k, label, icon]) => (
            <button key={k} className={section === k ? 'on' : ''} data-a="nav" data-x={k} onClick={() => onNav(k)}><i>{icon()}</i><span>{label}</span></button>
          ))}
          <div className="grow" />
          <button className={props.settingsOn ? 'on' : ''} data-a="nav" data-x="settings" onClick={() => onNav('settings')}><i>{I.gear()}</i><span>Settings</span></button>
          <button data-a="nav" data-x="lock" onClick={props.onLock}><i>{I.lock()}</i><span>Lock</span></button>
        </nav>
        <div id="view">{props.children}</div>
        <nav className="dock" id="dock" aria-label="Sections">
          {NAV.map(([k, label, icon]) => (
            <button key={k} className={section === k ? 'on' : ''} data-a="nav" data-x={k} onClick={() => onNav(k)}>{icon()}<span>{label}</span></button>
          ))}
        </nav>
      </div>
      <div id="layer">{props.layer}</div>
    </>
  );
}
