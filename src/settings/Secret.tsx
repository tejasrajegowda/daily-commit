import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  finishNewCode, checkCode, meter, newPassphrase, secretOpens, setMode, startNewCode, useApp, useNav,
  type Bars, type DeviceMode, type PendingCode, type Secret as Typed,
} from '../app/context.ts';
import { CodePad, MAX_DIGITS } from '../ui/CodePad.tsx';
import { codeGroups } from '../ui/codeGroups.ts';
import { I } from '../ui/icons.tsx';
import { TypeBack } from '../ui/TypeBack.tsx';

// The keys to the record: a new passphrase, a new recovery code (in use only once typed back),
// checking the code on paper, and how the app opens on this phone. Each change that needs the raw
// key asks for the passphrase first; it is read from its field once, kept only while this screen
// is open, and dropped when the screen goes.

const Note = ({ title, text }: { readonly title: string; readonly text: string }) => (
  <div className="panel note" data-a="secret-note" style={{ margin: '14px 0 0' }}><p className="eb">{title}</p><p className="body" style={{ margin: '8px 0 0' }}>{text}</p></div>
);

function Page({ children }: { readonly children: ReactNode }) {
  const { go } = useNav();
  return (
    <div className="center-col first secret">
      <button type="button" className="btn btn--text" data-a="secret-back" onClick={() => go('settings', 'privacy')} style={{ paddingLeft: 0, gap: 4, alignSelf: 'flex-start' }}>
        <span style={{ display: 'inline-flex', width: 18, height: 18 }}>{I.back()}</span>Settings
      </button>
      {children}
    </div>
  );
}

function Done({ title, text }: { readonly title: string; readonly text: string }) {
  const { go } = useNav();
  return (
    <div className="center-col first secret">
      <h1 className="t-l" data-a="secret-done">{title}</h1>
      <p className="body" style={{ margin: '12px 0 26px' }}>{text}</p>
      <button type="button" className="btn btn--primary wide" data-a="done" onClick={() => go('settings', 'privacy')}>Done</button>
    </div>
  );
}

const field = { autoComplete: 'off', autoCapitalize: 'off', autoCorrect: 'off', spellCheck: false } as const;

type Words = { readonly title: string; readonly text: string };

const NOT_CHECKED: Words = { title: 'Not checked', text: "That couldn't be checked just now. Nothing was changed." };
const NOT_SET: Words = { title: 'Not set', text: "That couldn't be set up. The way Daily Commit opened before still works." };

/** Asks for the passphrase and checks it opens the record before anything else happens. What
 * follows a right one runs while the button still says so; if it fails outright, `failed` is said. */
function AskPassphrase({ why, onRight, failed = NOT_CHECKED }: { readonly why: string; onRight(auth: Typed): void | Promise<void>; readonly failed?: Words }) {
  const deps = useApp();
  const input = useRef<HTMLInputElement>(null);
  const [wrong, setWrong] = useState(false);
  const [trouble, setTrouble] = useState<Words | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const go = async () => {
    const el = input.current;
    if (!el || busy) return;
    const auth: Typed = { method: 'passphrase', text: el.value };
    el.value = '';
    setTrouble(undefined);
    setBusy(true);
    try {
      if (!(await secretOpens(deps, auth))) setWrong(true);
      else await onRight(auth);
    } catch {
      setTrouble(failed);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Page>
      <h1 className="t-l" style={{ marginTop: 14 }}>Your passphrase first</h1>
      <p className="body" style={{ margin: '12px 0 0' }}>{why}</p>
      <form onSubmit={e => { e.preventDefault(); void go(); }}>
        <input ref={input} className="pass" type="password" aria-label="Passphrase" placeholder="Passphrase" disabled={busy} {...field} onInput={() => { setWrong(false); setTrouble(undefined); }} />
      </form>
      {wrong && <Note title="That didn't open it" text="Check the passphrase and try again. Nothing was changed." />}
      {trouble && <Note {...trouble} />}
      <button type="button" className="btn btn--primary wide" data-a="auth" disabled={busy} style={{ marginTop: 18 }} onClick={() => void go()}>{busy ? 'Checking…' : 'Continue'}</button>
    </Page>
  );
}

function Meter({ bars, label, extra }: { readonly bars: Bars; readonly label: string; readonly extra?: string }) {
  return (
    <>
      <div className="meter" aria-hidden="true">{[1, 2, 3, 4, 5].map(i => <i key={i} className={i <= bars ? 'on' : ''} />)}</div>
      <p className="meta" style={{ margin: '8px 4px 22px' }} data-a="meter"><b style={{ color: 'var(--ink-1)', fontWeight: 500 }}>{label}</b>{extra}</p>
    </>
  );
}

function ChangePassphrase() {
  const deps = useApp();
  const current = useRef<HTMLInputElement>(null);
  const next = useRef<HTMLInputElement>(null);
  const [strength, setStrength] = useState(meter(''));
  const [note, setNote] = useState<{ title: string; text: string } | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [code, setCode] = useState(false);              // a forgotten passphrase: the recovery code stands in
  if (done) return <Done title="Changed" text="Your new passphrase opens everything from now on. Copies saved before today still open with the previous one, until new copies replace them over the next few days." />;
  const change = async () => {
    const a = current.current;
    const b = next.current;
    if (!a || !b || busy) return;
    const was: Typed = { method: code ? 'recovery' : 'passphrase', text: a.value };
    const now = b.value;
    // read once, then emptied, whatever the outcome (C9)
    a.value = '';
    b.value = '';
    setStrength(meter(''));
    setBusy(true);
    const outcome = await newPassphrase(deps, was, now).catch(() => undefined).finally(() => setBusy(false));
    if (outcome?.kind === 'Saved') setDone(true);
    else if (outcome?.kind === 'TooShort') setNote({ title: 'A little longer', text: 'A new passphrase needs at least 15 characters. Five ordinary words is plenty.' });
    else if (outcome?.kind === 'WrongSecret') setNote(code
      ? { title: "That code didn't open it", text: 'Check the recovery code against the paper. Nothing was changed.' }
      : { title: "That isn't the current one", text: 'Check the current passphrase. Nothing was changed.' });
    else setNote({ title: 'Not changed', text: "That couldn't be saved. Your passphrase is as it was." });
  };
  return (
    <Page>
      <h1 className="t-l" style={{ marginTop: 14 }}>Change passphrase</h1>
      <p className="body" style={{ margin: '12px 0 0' }}>Only the lock on your record changes. Nothing in it is rewritten, so this takes a moment.</p>
      <form onSubmit={e => { e.preventDefault(); void change(); }}>
        <input ref={current} className="pass" type="password" aria-label={code ? 'Recovery code' : 'Current passphrase'} placeholder={code ? 'Recovery code' : 'Current passphrase'} style={{ marginTop: 22 }} disabled={busy} {...field} onInput={() => setNote(undefined)} />
        <input ref={next} className="pass" type="password" aria-label="New passphrase" placeholder="New passphrase" style={{ marginTop: 12 }} disabled={busy} {...field}
          onInput={e => { setStrength(meter(e.currentTarget.value)); setNote(undefined); }} />
      </form>
      <button type="button" className="btn btn--text" data-a="pass-usecode" disabled={busy} style={{ marginTop: 6 }}
        onClick={() => { if (current.current) current.current.value = ''; setNote(undefined); setCode(!code); }}>{code ? 'Use the current passphrase instead' : 'Forgotten it? Use the recovery code instead'}</button>
      <Meter bars={strength.bars} label={strength.label} extra={strength.label.startsWith('At least') ? ' · five ordinary words is plenty' : ' · at least 15 characters; five ordinary words is plenty'} />
      {note && <Note title={note.title} text={note.text} />}
      <button type="button" className="btn btn--primary wide" data-a="pass-change" disabled={busy} style={{ marginTop: 18 }} onClick={() => void change()}>{busy ? 'Changing…' : 'Change it'}</button>
    </Page>
  );
}

function CheckCode() {
  const deps = useApp();
  const [typed, setTyped] = useState('');
  const [result, setResult] = useState<boolean | undefined>(undefined);
  const [trouble, setTrouble] = useState(false);
  const [busy, setBusy] = useState(false);
  if (result) return <Done title="It matches" text="The code on your paper opens this record. Nothing was changed." />;
  const check = async () => {
    setBusy(true);
    setTrouble(false);
    try {
      setResult(await checkCode(deps, typed));
    } catch {
      setTrouble(true);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Page>
      <h1 className="t-l" style={{ marginTop: 14 }}>Check your recovery code</h1>
      <p className="body" style={{ margin: '12px 0 0' }}>Type it from the paper. Nothing changes; this only tells you the paper still works.</p>
      <TypeBack typed={typed} label="Recovery code, from the paper" onChange={t => { setTyped(t); setResult(undefined); setTrouble(false); }} />
      {trouble && <Note {...NOT_CHECKED} />}
      {result === false && <Note title="That doesn't match" text="Check each group against the paper. If the paper is lost or someone has seen it, make a new code; your passphrase is enough to do that." />}
      <button type="button" className="btn btn--primary wide" data-a="check" disabled={busy} style={{ marginTop: 18 }} onClick={() => void check()}>{busy ? 'Checking…' : 'Check'}</button>
    </Page>
  );
}

const NOT_CHANGED_CODE: Words = { title: 'Not changed', text: "That couldn't be saved. The old code still works." };

function NewCode() {
  const deps = useApp();
  const [pending, setPending] = useState<PendingCode | undefined>(undefined);
  const [typing, setTyping] = useState(false);
  const [typed, setTyped] = useState('');
  const [note, setNote] = useState<{ title: string; text: string } | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  if (done) return <Done title="The new code is in use" text="The old code no longer opens this record. Copies saved before today still open with the old code, until new copies replace them over the next few days." />;
  if (!pending) {
    return <AskPassphrase why="It makes the new code. Until you've typed the new one back, nothing changes and the old code still works." failed={NOT_CHANGED_CODE}
      onRight={async auth => {
        const r = await startNewCode(deps, auth);
        if (r.kind !== 'Pending') throw new Error('no new code');
        setPending(r.pending);
      }} />;
  }
  if (!typing) {
    return (
      <Page>
        <h1 className="t-l" style={{ marginTop: 14 }}>A new recovery code</h1>
        <p className="body" style={{ margin: '12px 0 0' }}>Write this one down. Once you've typed it back, the old code stops opening this record.</p>
        <div className="code well" data-a="code">{codeGroups(pending.code).map((g, i) => <span key={i}>{g}</span>)}</div>
        <p className="meta" style={{ margin: '0 0 22px' }}>Until then, nothing changes and the old code still works. Copies saved before the change still open with the old code until they're replaced.</p>
        <button type="button" className="btn btn--primary wide" data-a="written" onClick={() => setTyping(true)}>I've written it down</button>
        <p className="meta" style={{ textAlign: 'center', margin: '14px 0 0' }}>Next, you type it back. There is no skip.</p>
      </Page>
    );
  }
  const finish = async () => {
    setBusy(true);
    const r = await finishNewCode(deps, pending, typed).catch(() => undefined).finally(() => setBusy(false));
    if (r?.kind === 'Saved') setDone(true);
    else if (r?.kind === 'CodeMismatch') setNote({ title: "That doesn't match", text: 'Check each group against the paper, then try again. The old code still works.' });
    else setNote(NOT_CHANGED_CODE);
  };
  return (
    <Page>
      <h1 className="t-l" style={{ marginTop: 14 }}>Type it back</h1>
      <p className="body" style={{ margin: '12px 0 0' }}>From the paper, not from memory.</p>
      <TypeBack typed={typed} onChange={t => { setTyped(t); setNote(undefined); }} />
      {note && <Note title={note.title} text={note.text} />}
      <button type="button" className="btn btn--primary wide" data-a="finish" disabled={busy} style={{ marginTop: 18 }} onClick={() => void finish()}>{busy ? 'Saving…' : 'Use the new code'}</button>
    </Page>
  );
}

const OWN_WARNING = "Your own code stops people. Someone who can break into the phone's software could try every six-digit code in hours to days, and with this setting the passphrase does not stop that. The phone's own lock is checked by its security chip, which slows guessing down, so it is stronger against that. A longer code takes far longer: each extra two digits make it a hundred times as long, so hours become weeks.";

function OwnCode() {
  const deps = useApp();
  const { go } = useNav();
  const auth = useRef<Typed | undefined>(undefined);
  // the code is kept in refs and the screen holds only how many digits there are (C9)
  const first = useRef('');
  const digits = useRef('');
  const [count, setCount] = useState(0);
  const [step, setStep] = useState<'auth' | 'choose' | 'again'>('auth');
  const [note, setNote] = useState<{ title: string; text: string } | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  useEffect(() => () => { auth.current = undefined; first.current = ''; digits.current = ''; }, []);
  if (done) return <Done title="Your code is set" text="Daily Commit now opens with your code. Fingerprint can open it too, if you switch that on in Settings, Privacy." />;
  if (step === 'auth') return <AskPassphrase why="Setting up a code of your own needs it once." onRight={a => { auth.current = a; setStep('choose'); }} />;
  const set = (d: string) => { digits.current = d; setCount(d.length); };
  const ok = async () => {
    const typed = digits.current;
    set('');
    if (step === 'choose') {
      first.current = typed;
      setNote(undefined);
      setStep('again');
      return;
    }
    const chosen = first.current;
    first.current = '';
    if (typed !== chosen) {
      setStep('choose');
      setNote({ title: "Those weren't the same", text: 'Choose the code again, then type it once more.' });
      return;
    }
    const a = auth.current;
    if (!a) return;
    setBusy(true);
    const r = await setMode(deps, a, 'own-code', typed).catch(() => undefined).finally(() => setBusy(false));
    if (r?.kind !== 'Enrolled') setStep('choose');      // a failed try starts again from the first entry, which is gone
    if (r?.kind === 'Enrolled') { auth.current = undefined; setDone(true); }
    else if (r?.kind === 'NotVerified') go('settings', 'notverified');
    else setNote(NOT_SET);
  };
  return (
    <Page>
      <p className="eb" style={{ marginTop: 14 }}>{step === 'choose' ? 'Step 1 of 2' : 'Step 2 of 2'}</p>
      <h1 className="t-l" style={{ marginTop: 6 }}>{step === 'choose' ? 'Choose a code' : 'Type it again'}</h1>
      {step === 'choose' && <p className="body" style={{ margin: '12px 0 0' }}>{OWN_WARNING}</p>}
      {note && <Note title={note.title} text={note.text} />}
      <div className="lock lock--inline">
        <CodePad count={count} bio={false} busy={busy} label={step === 'choose' ? 'Next' : 'Set the code'}
          onDigit={d => { if (digits.current.length < MAX_DIGITS) set(digits.current + d); }} onDelete={() => set(digits.current.slice(0, -1))} onOk={() => void ok()} />
      </div>
      <p className="meta" style={{ textAlign: 'center', margin: '12px 0 0' }}>Six digits or more. Eight is a good length.</p>
    </Page>
  );
}

/** Switching to the phone's lock, or adding the fingerprint inside own-code mode. */
function SwitchMode({ mode }: { readonly mode: DeviceMode }) {
  const deps = useApp();
  const { go } = useNav();
  const why = mode === 'phone-lock' ? "Switching to your phone's lock needs it once." : 'Letting the fingerprint open it needs it once.';
  return (
    <AskPassphrase why={why} failed={NOT_SET} onRight={async auth => {
      const r = await setMode(deps, auth, mode);
      if (r.kind === 'Enrolled') go('settings', 'privacy');
      else if (r.kind === 'NotVerified') go('settings', 'notverified');
      else throw new Error('not set');
    }} />
  );
}

export function Secret() {
  const { nav } = useNav();
  switch (nav.variant) {
    case 'check': return <CheckCode />;
    case 'newcode': return <NewCode />;
    case 'owncode': return <OwnCode />;
    case 'phone': return <SwitchMode mode="phone-lock" />;
    case 'finger': return <SwitchMode mode="fingerprint" />;
    default: return <ChangePassphrase />;
  }
}
