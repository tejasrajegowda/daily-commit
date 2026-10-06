import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { clockMinuteOf } from '../rules/dates.ts';
import { LATEST } from '../record/backup/snapshot.ts';
import { FirstRun, type FoundCopy } from '../first-run/FirstRun.tsx';
import { Restore } from '../first-run/Restore.tsx';
import { LockScreen } from '../lock/LockScreen.tsx';
import { Diary } from '../diary/Diary.tsx';
import { NotYet } from '../diary/NotYet.tsx';
import { Habit } from '../look-back/Habit.tsx';
import { Month } from '../reviews/Month.tsx';
import { Plan } from '../plan/Plan.tsx';
import { Secret } from '../settings/Secret.tsx';
import { Settings } from '../settings/Settings.tsx';
import { Support } from '../settings/Support.tsx';
import { applyDisplay } from '../ui/display.ts';
import { Week } from '../reviews/Week.tsx';
import { LookBack } from '../look-back/LookBack.tsx';
import { Today } from '../today/Today.tsx';
import { Frame, type Section } from '../ui/Shell.tsx';
import { AppContext, HeldContext, NavContext, type AppDeps, type DeviceMode, type Nav, type ScreenId } from './context.ts';
import { screenOf, type LockState } from './lockMachine.ts';
import { heldWords } from './heldWords.ts';
import { PausedGate } from './Paused.tsx';
import { readBackupFile } from './restoreSteps.ts';
import { displayOf } from './yourData.ts';

// The app: it draws exactly what the lock allows. Black until the phone answers, the lock screen
// while locked, and the record only while it is open. Leaving ends whatever was open on screen, and
// the next unlock starts at Today.

const HOME: Nav = { screen: 'today', variant: '' };

const SECTION: Partial<Record<ScreenId, Section>> = {
  today: 'today', look: 'look', habit: 'look', week: 'look', month: 'look', diary: 'diary', notyet: 'diary', plan: 'plan',
  // Settings and Support are reached from Plan on a phone, so its tab stays lit there, as the design draws it
  settings: 'plan', support: 'plan',
};

/** Screens drawn without the bars. */
const BARE: ReadonlySet<ScreenId> = new Set(['secret']);

/**
 * Restore runs as a flow of its own: it stays on screen through the lock it causes, and a leave ends it.
 * `unopened`: it was opened from the lock screen of a record that can't be opened, and Back returns there.
 */
type Flow = { readonly kind: 'restore'; readonly preset?: FoundCopy; readonly unopened?: boolean } | undefined;

const TITLES: Record<ScreenId, string> = {
  today: 'Today', look: 'Look back', habit: 'Habit', week: 'This week', month: 'This month', diary: 'Diary', notyet: 'Not yet',
  plan: 'Plan', settings: 'Settings', support: 'Support', restore: 'Restore from a backup', secret: 'Settings',
};

/** A screen not built yet: its heading only. */
function Placeholder({ screen }: { readonly screen: ScreenId }) {
  return <div className="scr"><main className="col"><h1 className="t-l">{TITLES[screen]}</h1></main></div>;
}

/** The screens that show habits: while tracking is paused, one quiet panel stands in for them. */
const paused = (nav: Nav, screen: ReactNode) => <PausedGate title={TITLES[nav.screen]}>{screen}</PausedGate>;

function recordScreen(nav: Nav): ReactNode {
  switch (nav.screen) {
    // a date as the variant asks for yesterday, while it is still yesterday
    case 'today': return paused(nav, <Today asked={nav.variant} />);
    case 'look': return paused(nav, <LookBack />);
    case 'habit': return paused(nav, <Habit />);
    case 'week': return paused(nav, <Week />);
    case 'diary': return <Diary />;
    case 'notyet': return <NotYet />;
    case 'plan': return <Plan />;
    case 'month': return paused(nav, <Month />);
    case 'support': return <Support />;
    case 'settings': return <Settings key={nav.variant} />;
    case 'secret': return <Secret key={nav.variant} />;
    default: return <Placeholder screen={nav.screen} />;
  }
}

/** Night runs from 19:00 to 05:00; the whole app turns warm. */
const isNight = (minute: number) => minute >= 1140 || minute < 300;

export function App({ deps, initial }: { readonly deps: AppDeps; readonly initial?: Nav }) {
  const { core, machine, store, lock, device, clock } = deps;
  const state: LockState = useSyncExternalStore(change => machine.listen(() => change()), () => machine.state);
  const [nav, setNav] = useState<Nav>(initial && initial.screen !== 'restore' ? initial : HOME);
  const [flow, setFlow] = useState<Flow>(initial?.screen === 'restore' ? { kind: 'restore' } : undefined);
  const [hasVault, setHasVault] = useState<boolean | undefined>(undefined);
  const [found, setFound] = useState<FoundCopy | undefined>(undefined);
  const [passphraseOnly, setPassphraseOnly] = useState(false);
  const [byCode, setByCode] = useState(false);          // the recovery code in place of the passphrase, kept across a failed try
  const [writing, setWriting] = useState(false);
  const [held] = useState(heldWords);                    // words whose save didn't go through, for this visit only
  const offered = useRef<readonly DeviceMode[]>([]);
  if (state.kind === 'Locked' && state.offered !== undefined) offered.current = state.offered;

  useEffect(() => {
    let live = true;
    void (async () => {
      const v = await core.hasVault();
      // a new phone: Android may have put back a locked copy before the app first opened
      const copy = v ? undefined : await device.files.read(LATEST).catch(() => undefined);
      const read = copy ? readBackupFile(copy) : undefined;
      if (!live) return;
      if (read?.kind === 'File') setFound({ bytes: read.bytes, madeAt: read.madeAt });
      setHasVault(v);
    })();
    return () => { live = false; };
  }, [core, device]);

  useEffect(() => machine.listen(next => {
    store.changed();
    if (next.kind !== 'Open') held.clear();             // held words never outlast the visit they were typed in
    if (next.kind === 'Open') {
      lock.clear();
      setPassphraseOnly(false);
      setByCode(false);
    }
    if (next.kind === 'Locking') {
      lock.clear();
      setPassphraseOnly(false);
      setByCode(false);
      setFlow(undefined);
      setNav(HOME);                                      // nothing that was open on screen survives a lock
    }
  }), [machine, store, lock, held]);

  useEffect(() => {
    void displayOf(deps).then(applyDisplay, () => {});   // this device's contrast and dimming, before unlock
  }, [deps]);

  useEffect(() => {
    // the diary page has focus: the bars step back while it is written in
    const track = () => setWriting(document.activeElement instanceof HTMLElement && document.activeElement.matches('.diary [data-a="page-text"]'));
    const later = () => setTimeout(track);              // focus has moved on only after focusout
    document.addEventListener('focusin', track);
    document.addEventListener('focusout', later);
    return () => { document.removeEventListener('focusin', track); document.removeEventListener('focusout', later); };
  }, []);

  useEffect(() => {
    const stopLeave = device.onLeave(() => {
      // a leave from the lock screen forgets it too: the note, a wrong code before, the way chosen
      lock.clear();
      setPassphraseOnly(false);
      setByCode(false);
      void machine.leave();
    });
    const stopResume = device.onResume(() => void machine.resume());
    return () => { stopLeave(); stopResume(); };
  }, [device, machine, lock]);

  useEffect(() => {
    if (hasVault) void machine.resume();                 // asks the phone which ways to open it are there
  }, [hasVault, machine]);

  const minute = useSyncExternalStore(clock.subscribe, clock.minute);
  const tz = core.session?.model.settings.tz ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  useEffect(() => {
    document.documentElement.dataset.phase = isNight(clockMinuteOf(minute, tz)) ? 'night' : 'dawn';
  }, [minute, tz]);

  const navValue = useMemo(() => ({
    nav,
    go: (screen: ScreenId, variant = '') => {
      if (screen === 'restore') setFlow({ kind: 'restore' });
      else setNav({ screen, variant });
      window.scrollTo(0, 0);
    },
  }), [nav]);
  const closeRestore = (outcome: 'back' | 'restored') => {
    setFlow(undefined);
    if (outcome === 'restored') {
      lock.clear();                                      // the restored record's lock screen starts with no note
      setHasVault(true);
      void machine.resume();                             // the lock screen, asking the phone afresh
    }
  };
  // the rail's Lock: the app stays in front, so once locked it asks the phone again and the lock screen shows
  const leave = () => void machine.leave().then(() => machine.resume());
  const onNav = (to: Section | 'settings') => navValue.go(to);

  const screen = screenOf(state);
  let body: ReactNode = null;
  let bare = true;
  if (hasVault === undefined) body = null;
  else if (flow?.kind === 'restore') body = <Restore replacing={hasVault} unopened={flow.unopened} preset={flow.preset} onClose={closeRestore} />;
  else if (hasVault === false) body = <FirstRun found={found} onRestore={preset => setFlow({ kind: 'restore', preset })} onDone={() => setHasVault(true)} />;
  else if (screen === 'blank') body = null;
  else if (screen === 'lock') body = <LockScreen offered={offered.current} busy={state.kind === 'Unlocking'} passphraseOnly={passphraseOnly} setPassphraseOnly={setPassphraseOnly} byCode={byCode} setByCode={setByCode} onRestore={() => setFlow({ kind: 'restore', unopened: true })} />;
  else {
    body = recordScreen(nav);
    bare = BARE.has(nav.screen);
  }

  return (
    <AppContext.Provider value={deps}>
      <NavContext.Provider value={navValue}>
        <HeldContext.Provider value={held}>
          <Frame bare={bare} writing={writing && !bare} section={SECTION[nav.screen]} settingsOn={nav.screen === 'settings' || nav.screen === 'support'} onNav={onNav} onLock={leave}>
            {body}
          </Frame>
        </HeldContext.Provider>
      </NavContext.Provider>
    </AppContext.Provider>
  );
}
