import { useRef, useState } from 'react';
import { finishFirstRun, firstSettings, prepareVault, useApp, type Prepared } from '../app/context.ts';
import { I } from '../ui/icons.tsx';
import { codeGroups, typedGroups } from './codeGroups.ts';
import { meter, type Bars } from './meter.ts';
import { madeAtWords } from './restoreWords.ts';

// The first day: four steps, once, never repeated. The passphrase is read from its field once, at
// Continue, and stretched into the keys; the field is emptied and nothing keeps it. The recovery
// code is shown, then typed back from the paper; only then is anything written.

export interface FoundCopy {
  readonly bytes: Uint8Array;
  readonly madeAt: number;
}

export interface FirstRunProps {
  /** a locked copy Android put back on a new phone, if there is one */
  readonly found?: FoundCopy;
  onRestore(found?: FoundCopy): void;
  onDone(): void;
}

const tz = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

function Steps({ step }: { readonly step: number }) {
  return (
    <>
      <div className="steps">{[1, 2, 3, 4].map(i => <i key={i} className={i <= step ? 'on' : ''} />)}</div>
      <p className="eb">Step {step} of 4 · the first day only</p>
    </>
  );
}

function Note({ title, text }: { readonly title: string; readonly text: string }) {
  return <div className="panel note"><p className="eb">{title}</p><p className="body" style={{ margin: '8px 0 0' }}>{text}</p></div>;
}

export function FirstRun(props: FirstRunProps) {
  const deps = useApp();
  const [step, setStep] = useState(props.found ? 0 : 1);
  const [strength, setStrength] = useState<{ readonly bars: Bars; readonly label: string }>(meter(''));
  const [tooShort, setTooShort] = useState(false);
  const [busy, setBusy] = useState(false);
  const [prepared, setPrepared] = useState<Prepared | undefined>(undefined);
  const [typed, setTyped] = useState('');
  const [mismatch, setMismatch] = useState(false);
  const [refused, setRefused] = useState<string | undefined>(undefined);
  const field = useRef<HTMLInputElement>(null);

  if (step === 0 && props.found) {
    return (
      <div className="center-col first">
        <div className="fr-mark">{I.brand()}</div>
        <h1 className="t-l" style={{ marginTop: 6 }}>Your record came back with this phone</h1>
        <p className="body" style={{ margin: '12px 0 0' }}>Android restored a locked copy made on {madeAtWords(props.found.madeAt, tz())}. Your passphrase or your recovery code opens it.</p>
        <div style={{ marginTop: 28 }}>
          <button type="button" className="btn btn--primary wide" data-a="restore" onClick={() => props.onRestore(props.found)}>Restore it</button>
          <button type="button" className="btn btn--secondary wide" data-a="fstep" style={{ marginTop: 10 }} onClick={() => setStep(1)}>Start new instead</button>
          <p className="meta" style={{ textAlign: 'center', margin: '14px 0 0' }}>Starting new keeps that copy for a few days, then the new record's own copies replace it.</p>
        </div>
      </div>
    );
  }

  const next = (label: string, onClick: () => void, sub?: string) => (
    <>
      <button type="button" className="btn btn--primary wide" data-a="fstep" disabled={busy} onClick={onClick}>{label}</button>
      {sub && <p className="meta" style={{ textAlign: 'center', margin: '14px 0 0' }}>{sub}</p>}
    </>
  );

  if (step === 1) {
    return (
      <div className="center-col first">
        <Steps step={1} />
        <div className="fr-mark">{I.brand()}</div>
        <h1 className="t-xl" style={{ marginTop: 6 }}>Daily Commit</h1>
        <p className="body" style={{ margin: '10px 0 26px' }}>A private notebook for your days — what today is going to be, what it was, and anything you want to write down.</p>
        <div className="fr-facts">
          <div><p className="eb">Yours alone</p><p className="body">Everything you write is locked with a passphrase only you know. Nobody else can open it — not a company, and not whoever built this.</p></div>
          <div><p className="eb">How habits actually form</p><p className="body">In the study most apps quote, habits took anywhere from 18 to 254 days, and missing a day didn't set anyone back.</p></div>
          <div><p className="eb">If it stops helping</p><p className="body">This is a notebook, not a treatment. If the habits stop feeling like a choice and start feeling compulsory, a person will help more than an app.</p></div>
        </div>
        <div style={{ marginTop: 28 }}>
          {next('Begin', () => setStep(2), 'This is said once, here, and never again.')}
          <button type="button" className="btn btn--text wide" data-a="restore" style={{ marginTop: 6 }} onClick={() => props.onRestore()}>Restore from a backup instead</button>
        </div>
      </div>
    );
  }

  if (step === 2) {
    const onContinue = async () => {
      const el = field.current;
      if (!el || busy) return;
      const text = el.value;
      const result = text ? await (async () => { setBusy(true); try { return await prepareVault(deps, text); } finally { setBusy(false); } })() : { kind: 'TooShort' as const };
      if (result.kind === 'TooShort') {
        setTooShort(true);
        return;
      }
      el.value = '';
      setPrepared(result.prepared);
      setStep(3);
    };
    return (
      <div className="center-col first">
        <Steps step={2} />
        <h1 className="t-l" style={{ marginTop: 10 }}>Choose a passphrase</h1>
        <p className="body" style={{ margin: '12px 0 0' }}>Five ordinary words you'll remember. Length is what makes it strong: at least 15 characters, and no symbols or numbers needed.</p>
        <form onSubmit={e => { e.preventDefault(); void onContinue(); }}>
          <input ref={field} className="pass" type="password" aria-label="Passphrase" style={{ marginTop: 22 }}
            autoComplete="off" autoCapitalize="off" autoCorrect="off" spellCheck={false} disabled={busy}
            onInput={e => { setStrength(meter(e.currentTarget.value)); setTooShort(false); }} />
        </form>
        <div className="meter" aria-hidden="true">{[1, 2, 3, 4, 5].map(i => <i key={i} className={i <= strength.bars ? 'on' : ''} />)}</div>
        <p className="meta" style={{ margin: '8px 4px 22px' }} data-a="meter">
          <b style={{ color: 'var(--ink-1)', fontWeight: 500 }}>{strength.label}</b>{tooShort ? ' · it needs to be longer before it can lock anything' : ''}
        </p>
        <p className="meta" style={{ margin: '0 0 22px' }}>It is never stored anywhere — not on this phone, not online. If it's ever forgotten, the recovery code on the next screen is the only way back.</p>
        {next(busy ? 'Making your lock…' : 'Continue', () => void onContinue())}
      </div>
    );
  }

  if (step === 3 && prepared) {
    return (
      <div className="center-col first">
        <Steps step={3} />
        <h1 className="t-l" style={{ marginTop: 10 }}>Your recovery code</h1>
        <p className="body" style={{ margin: '12px 0 0' }}>If you ever forget your passphrase, this is the only way back into the diary. Write it on paper and keep it away from this phone and your laptop.</p>
        <div className="code well" data-a="code">{codeGroups(prepared.code).map((g, i) => <span key={i}>{g}</span>)}</div>
        <p className="meta" style={{ margin: '0 0 22px' }}>No I, L, O or U anywhere — so nothing can be misread when it's handwritten. If this code and the passphrase are both lost, the diary cannot be opened by anyone, including you.</p>
        {next("I've written it down", () => setStep(4), 'Next, you type it back. There is no skip.')}
      </div>
    );
  }

  if (!prepared) return null;
  const groups = typedGroups(typed);
  const onFinish = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const result = await finishFirstRun(deps, prepared, typed, firstSettings(deps.core.now(), tz()));
      if (result.kind === 'Saved') props.onDone();
      else if (result.kind === 'CodeMismatch') setMismatch(true);
      else setRefused(result.kind === 'QuotaFull' ? 'The phone is out of space, so nothing was written. Free some space and finish again.' : "That couldn't be written. Nothing was kept; finish again.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="center-col first">
      <Steps step={4} />
      <h1 className="t-l" style={{ marginTop: 10 }}>Type it back</h1>
      <p className="body" style={{ margin: '12px 0 0' }}>From the paper, not from memory. This is how both of us know the code you wrote down works.</p>
      <div style={{ position: 'relative' }}>
        <div className="code well typeback" aria-hidden="true">
          {Array.from({ length: 9 }, (_, i) => {
            const done = groups.done[i];
            if (done !== undefined) return <span key={i} className="done">{done}</span>;
            if (i === groups.done.length) return <span key={i} className="cur">{groups.current}<i className="caret" /></span>;
            return <span key={i}>{i === 8 ? '·' : '·····'}</span>;
          })}
        </div>
        <input className="typeback-in" aria-label="Recovery code, typed back" value={typed} maxLength={60}
          autoComplete="off" autoCapitalize="characters" autoCorrect="off" spellCheck={false}
          style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', opacity: 0 }}
          onChange={e => { setTyped(e.currentTarget.value); setMismatch(false); }} />
      </div>
      {mismatch && <div style={{ margin: '0 0 18px' }}><Note title="That doesn't match" text="Check each group against the paper, then finish again." /></div>}
      {refused && <div style={{ margin: '0 0 18px' }}><Note title="Not saved" text={refused} /></div>}
      <p className="meta" style={{ margin: '0 0 12px' }}>There's no skip. Once it matches, the app opens and this never appears again.</p>
      {deps.device.deviceModes && <p className="meta" style={{ margin: '0 0 22px' }}>Day to day, Daily Commit opens with your phone's own lock. You can give it a separate code of its own any time, in Settings → Privacy.</p>}
      <button type="button" className="btn btn--primary wide" data-a="finish" disabled={busy} onClick={() => void onFinish()}>{busy ? 'Opening…' : 'Finish'}</button>
    </div>
  );
}
