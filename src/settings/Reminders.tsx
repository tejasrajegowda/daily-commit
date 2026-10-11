import { useEffect, useState, type ReactNode } from 'react';
import { useApp, useNav, writeNotifAsked } from '../app/context.ts';
import { I } from '../ui/icons.tsx';
import { isSamsung, REMINDER_WORDS as W } from './settingsWords.ts';

// Reminders on this phone: before Android asks, keeping them arriving (Samsung only), and what a
// locked phone shows. No button opens Android's Settings: that would be a hand-off into a place the
// person then browses. Android's question is asked once ever, and only from Continue.

type Step = 'ask' | 'samsung' | 'lockscreen' | 'denied';

export function Reminders() {
  const deps = useApp();
  const { nav, go } = useNav();
  const [step, setStep] = useState<Step>((['ask', 'samsung', 'lockscreen', 'denied'] as const).find(s => s === nav.variant) ?? 'ask');
  const [samsung, setSamsung] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => { void deps.device.info?.().then?.(i => setSamsung(isSamsung(i.manufacturer)), () => {}); }, [deps]);
  const of = samsung ? 3 : 2;
  const back = () => go('settings', 'day');
  const head = (n: number) => (
    <>
      <div className="steps" style={{ margin: '16px 0 0' }}>{Array.from({ length: of }, (_, i) => <i key={i} className={i < n ? 'on' : ''} />)}</div>
      <p className="eb" style={{ marginTop: 12 }}>{W.step(n, of)}</p>
    </>
  );
  const page = (children: ReactNode) => (
    <div className="center-col first">
      <button type="button" className="btn btn--text" data-a="setup-back" style={{ paddingLeft: 0, gap: 4, alignSelf: 'flex-start' }} onClick={back}>
        <span style={{ display: 'inline-flex', width: 18, height: 18 }}>{I.back()}</span>Settings
      </button>
      {children}
    </div>
  );
  const steps = (items: readonly string[]) => <ol className="how">{items.map(s => <li key={s}>{s}</li>)}</ol>;
  const ask = async () => {
    const port = deps.device.reminders;
    if (!port || busy) return;
    setBusy(true);
    try {
      await writeNotifAsked(deps).catch(() => {});             // once ever, whatever the answer
      const allowed = await port.ask();
      setStep(allowed ? (samsung ? 'samsung' : 'lockscreen') : 'denied');
      deps.store.changed();                                    // the schedule can be handed over now
    } catch {
      setStep('denied');
    } finally {
      setBusy(false);
    }
  };
  if (step === 'denied') return page(<>
    <h1 className="t-l" style={{ marginTop: 16 }}>{W.denied.title}</h1>
    <p className="body" style={{ margin: '12px 0 0' }}>{W.denied.text}</p>
    <p className="meta" style={{ margin: '16px 0 24px' }}>{W.denied.note}</p>
    <button type="button" className="btn btn--primary wide" data-a="setup-done" onClick={back}>{W.denied.done}</button>
  </>);
  if (step === 'samsung') return page(<>{head(2)}
    <h1 className="t-l" style={{ marginTop: 8 }}>{W.samsung.title}</h1>
    <p className="body" style={{ margin: '12px 0 0' }}>{W.samsung.text}</p>
    {steps(W.samsung.steps)}
    <p className="meta" style={{ margin: '0 0 24px' }}>{W.samsung.note}</p>
    <div className="two">
      <button type="button" className="btn btn--secondary" data-a="setup-leave" onClick={() => setStep('lockscreen')}>{W.samsung.leave}</button>
      <button type="button" className="btn btn--secondary" data-a="setup-next" onClick={() => setStep('lockscreen')}>{W.samsung.next}</button>
    </div>
  </>);
  if (step === 'lockscreen') return page(<>{head(of)}
    <h1 className="t-l" style={{ marginTop: 8 }}>{W.lockscreen.title}</h1>
    <p className="body" style={{ margin: '12px 0 0' }}>{W.lockscreen.text}</p>
    {steps(W.lockscreen.steps)}
    <p className="meta" style={{ margin: '0 0 24px' }}>{W.lockscreen.note}</p>
    <button type="button" className="btn btn--primary wide" data-a="setup-done" onClick={back}>{W.lockscreen.done}</button>
  </>);
  return page(<>{head(1)}
    <h1 className="t-l" style={{ marginTop: 8 }}>{W.ask.title}</h1>
    <p className="body" style={{ margin: '12px 0 0' }}>{W.ask.text}</p>
    <p className="meta" style={{ margin: '16px 0 24px' }}>{W.ask.note}</p>
    <div className="two">
      <button type="button" className="btn btn--secondary" data-a="setup-notnow" disabled={busy} onClick={back}>{W.ask.notNow}</button>
      <button type="button" className="btn btn--secondary" data-a="setup-continue" disabled={busy} onClick={() => void ask()}>{W.ask.go}</button>
    </div>
  </>);
}
