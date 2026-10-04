import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { clockMinuteOf } from '../rules/dates.ts';
import { LockScreen } from '../lock/LockScreen.tsx';
import { Today } from '../today/Today.tsx';
import { Frame, type Section } from '../ui/Shell.tsx';
import { AppContext, NavContext, type AppDeps, type DeviceMode, type Nav, type ScreenId } from './context.ts';
import { screenOf, type LockState } from './lockMachine.ts';

// The app: it draws exactly what the lock allows. Black until the phone answers, the lock screen
// while locked, and the record only while it is open. Leaving ends whatever was open on screen, and
// the next unlock starts at Today.

const HOME: Nav = { screen: 'today', variant: '' };

const SECTION: Partial<Record<ScreenId, Section>> = {
  today: 'today', look: 'look', habit: 'look', week: 'look', month: 'look', diary: 'diary', notyet: 'diary', plan: 'plan',
};

/** Screens drawn without the bars. */
const BARE: ReadonlySet<ScreenId> = new Set(['restore', 'secret']);

const TITLES: Record<ScreenId, string> = {
  today: 'Today', look: 'Look back', habit: 'Habit', week: 'This week', month: 'This month', diary: 'Diary', notyet: 'Not yet',
  plan: 'Plan', settings: 'Settings', support: 'Support', restore: 'Restore from a backup', secret: 'Settings',
};

/** A screen not built yet: its heading only. */
function Placeholder({ screen }: { readonly screen: ScreenId }) {
  return <div className="scr"><main className="col"><h1 className="t-l">{TITLES[screen]}</h1></main></div>;
}

function recordScreen(nav: Nav): ReactNode {
  switch (nav.screen) {
    case 'today': return <Today />;
    default: return <Placeholder screen={nav.screen} />;
  }
}

/** Night runs from 19:00 to 05:00; the whole app turns warm. */
const isNight = (minute: number) => minute >= 1140 || minute < 300;

export function App({ deps, initial }: { readonly deps: AppDeps; readonly initial?: Nav }) {
  const { core, machine, store, lock, device, clock } = deps;
  const state: LockState = useSyncExternalStore(change => machine.listen(() => change()), () => machine.state);
  const [nav, setNav] = useState<Nav>(initial ?? HOME);
  const [hasVault, setHasVault] = useState<boolean | undefined>(undefined);
  const [passphraseOnly, setPassphraseOnly] = useState(false);
  const offered = useRef<readonly DeviceMode[]>([]);
  if (state.kind === 'Locked' && state.offered !== undefined) offered.current = state.offered;

  useEffect(() => {
    let live = true;
    void core.hasVault().then(v => { if (live) setHasVault(v); });
    return () => { live = false; };
  }, [core]);

  useEffect(() => machine.listen(next => {
    store.changed();
    if (next.kind === 'Open') {
      lock.clear();
      setPassphraseOnly(false);
    }
    if (next.kind === 'Locking') {
      lock.clear();
      setPassphraseOnly(false);
      setNav(HOME);                                      // nothing that was open on screen survives a lock
    }
  }), [machine, store, lock]);

  useEffect(() => {
    const stopLeave = device.onLeave(() => void machine.leave());
    const stopResume = device.onResume(() => void machine.resume());
    return () => { stopLeave(); stopResume(); };
  }, [device, machine]);

  useEffect(() => {
    if (hasVault) void machine.resume();                 // asks the phone which ways to open it are there
  }, [hasVault, machine]);

  const minute = useSyncExternalStore(clock.subscribe, clock.minute);
  const tz = core.session?.model.settings.tz ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  useEffect(() => {
    document.documentElement.dataset.phase = isNight(clockMinuteOf(minute, tz)) ? 'night' : 'dawn';
  }, [minute, tz]);

  const navValue = useMemo(() => ({ nav, go: (screen: ScreenId, variant = '') => { setNav({ screen, variant }); window.scrollTo(0, 0); } }), [nav]);
  // the rail's Lock: the app stays in front, so once locked it asks the phone again and the lock screen shows
  const leave = () => void machine.leave().then(() => machine.resume());
  const onNav = (to: Section | 'settings') => navValue.go(to);

  const screen = screenOf(state);
  let body: ReactNode = null;
  let bare = true;
  if (hasVault === false) body = <div className="center-col first" />;  // the first day arrives with its task
  else if (hasVault === undefined || screen === 'blank') body = null;
  else if (screen === 'lock') body = <LockScreen offered={offered.current} busy={state.kind === 'Unlocking'} passphraseOnly={passphraseOnly} setPassphraseOnly={setPassphraseOnly} />;
  else {
    body = recordScreen(nav);
    bare = BARE.has(nav.screen);
  }

  return (
    <AppContext.Provider value={deps}>
      <NavContext.Provider value={navValue}>
        <Frame bare={bare} section={SECTION[nav.screen]} settingsOn={nav.screen === 'settings' || nav.screen === 'support'} onNav={onNav} onLock={leave}>
          {body}
        </Frame>
      </NavContext.Provider>
    </AppContext.Provider>
  );
}
