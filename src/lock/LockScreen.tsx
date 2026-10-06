import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { NOTE_WORDS, useApp, useLockNote, type DeviceMode, type LockNote } from '../app/context.ts';
import { I } from '../ui/icons.tsx';
import { useWide } from '../ui/useWide.ts';
import { CodePad, MAX_DIGITS, MIN_DIGITS } from '../ui/CodePad.tsx';
import { fingerprintKey, lockLayout } from './lockView.ts';

// The lock screen. What it offers comes only from the device copies that exist. The passphrase is
// read from its field once, when Open is pressed, and the field is emptied; it is never kept. An
// own code is kept in a ref, and only how many digits there are is drawn. A record that can't be
// opened gets a way to Restore beside its note, since a backup may still open it.

export interface LockScreenProps {
  readonly offered: readonly DeviceMode[];
  readonly busy: boolean;
  /** the person chose the passphrase; kept by the app, so a failed try's brief blank doesn't forget it */
  readonly passphraseOnly: boolean;
  setPassphraseOnly(on: boolean): void;
  readonly byCode: boolean;
  setByCode(on: boolean): void;
  /** Restore from a backup, offered only when the record can't be opened */
  onRestore(): void;
}

export function LockScreen(props: LockScreenProps) {
  const { offered, busy, passphraseOnly, setPassphraseOnly, byCode, setByCode, onRestore } = props;
  const { lock } = useApp();
  const note = useLockNote();
  const wide = useWide();
  const layout = passphraseOnly ? 'passphrase' : lockLayout(offered, wide);

  if (layout === 'passphrase') {
    const back = !wide && offered.length > 0 && passphraseOnly;
    return <PassphraseLock wide={wide} note={note} busy={busy} onRestore={onRestore} code={byCode} setCode={setByCode} back={back ? (offered.includes('own-code') ? 'Use your code' : 'Use fingerprint') : undefined} onBack={() => setPassphraseOnly(false)} />;
  }
  if (layout === 'code') return <CodeLock bio={fingerprintKey(offered)} note={note} busy={busy} onRestore={onRestore} onPassphrase={() => setPassphraseOnly(true)} />;
  return (
    <div className="lock">
      <div className="lk-mark">{I.brand()}</div>
      <p className="eb lk-eb" style={note ? { marginBottom: 22 } : undefined}>Locked</p>
      {note && <NoteCard note={note} busy={busy} onRestore={onRestore} />}
      <button type="button" className="lk-finger" data-a="bio" aria-label="Unlock with fingerprint" disabled={busy} onClick={() => void lock.unlock({ mode: 'phone-lock' })}>{I.finger()}</button>
      <p className="lk-hint">Touch the sensor</p>
      <button type="button" className="btn btn--text lk-alt" data-a="devcred" disabled={busy} onClick={() => void lock.unlock({ mode: 'phone-lock' })}>Use your phone's PIN or pattern</button>
      <button type="button" className="btn btn--text" data-a="lockpass" style={{ fontSize: 13, color: 'var(--ink-4)' }} onClick={() => setPassphraseOnly(true)}>Use your passphrase</button>
    </div>
  );
}

function NoteCard({ note, busy, onRestore }: { readonly note: LockNote; readonly busy: boolean; onRestore(): void }) {
  const words = NOTE_WORDS[note];
  return (
    <div className="panel note lk-note">
      {words.title && <p className="eb">{words.title}</p>}
      <p className="body" style={{ margin: words.title ? '8px 0 0' : 0 }}>{words.text}</p>
      {note === 'damaged' && <RestoreLink busy={busy} onRestore={onRestore} style={{ paddingLeft: 0, marginTop: 4 }} />}
    </div>
  );
}

function RestoreLink({ busy, onRestore, style }: { readonly busy: boolean; onRestore(): void; readonly style?: CSSProperties }) {
  return <button type="button" className="btn btn--text" data-a="lockrestore" style={style} disabled={busy} onClick={onRestore}>Restore from a backup</button>;
}

function PassphraseLock(p: { readonly wide: boolean; readonly note: LockNote | undefined; readonly busy: boolean; onRestore(): void; readonly code: boolean; setCode(on: boolean): void; readonly back?: string; onBack(): void }) {
  const { lock } = useApp();
  const field = useRef<HTMLInputElement>(null);
  // the recovery code stands in for a forgotten passphrase: the first day's "the only way back"
  const { code, setCode } = p;
  const open = () => {
    const el = field.current;
    if (!el || p.busy) return;
    const text = el.value;
    el.value = '';
    if (text.trim()) void lock.unlock({ method: code ? 'recovery' : 'passphrase', text });
  };
  const switchTo = (next: boolean) => {
    if (field.current) field.current.value = '';
    setCode(next);
  };
  return (
    <div className="lock">
      <div className="lk-mark">{I.brand()}</div>
      <p className="eb lk-eb" style={p.note ? { marginBottom: 22 } : undefined}>Locked</p>
      {p.note && <NoteCard note={p.note} busy={p.busy} onRestore={p.onRestore} />}
      <form className="lk-pass" onSubmit={e => { e.preventDefault(); open(); }}>
        <input ref={field} className="pass" type="password" placeholder={code ? 'Recovery code' : 'Passphrase'} aria-label={code ? 'Recovery code' : 'Passphrase'}
          autoComplete="off" autoCapitalize={code ? 'characters' : 'off'} autoCorrect="off" spellCheck={false} disabled={p.busy} />
        <button type="submit" className="btn btn--primary wide" data-a="unlock" disabled={p.busy}>{p.busy ? 'Opening…' : 'Open'}</button>
      </form>
      <p className="lk-hint">{code ? "The code from the first day, as written on paper. Spaces don't matter." : p.wide ? 'This computer never remembers it, and the app locks again when you leave the tab.' : 'Five words. Your phone never stores them.'}</p>
      <button type="button" className="btn btn--text lk-alt" data-a="usecode" disabled={p.busy} onClick={() => switchTo(!code)}>{code ? 'Use the passphrase instead' : 'Use the recovery code instead'}</button>
      {p.back && <button type="button" className="btn btn--text lk-alt" data-a="lockbio" onClick={p.onBack}>{p.back}</button>}
    </div>
  );
}

function CodeLock(p: { readonly bio: boolean; readonly note: LockNote | undefined; readonly busy: boolean; onRestore(): void; onPassphrase(): void }) {
  const { lock } = useApp();
  const digits = useRef('');
  const [count, setCount] = useState(0);
  const [fading, setFading] = useState(false);

  const add = (d: string) => {
    if (digits.current.length >= MAX_DIGITS || p.busy) return;
    digits.current += d;
    setCount(digits.current.length);
  };
  const drop = () => {
    digits.current = digits.current.slice(0, -1);
    setCount(digits.current.length);
  };
  const ok = async () => {
    if (digits.current.length < MIN_DIGITS || p.busy) return;
    const code = digits.current;
    digits.current = '';
    setCount(0);
    const outcome = await lock.unlock({ mode: 'own-code', code });
    if (outcome.kind === 'WrongCode') {
      setFading(true);
      setTimeout(() => setFading(false), 400);
    }
  };
  // a laptop's keyboard types the code too
  const keys = useRef({ add, drop, ok });
  keys.current = { add, drop, ok };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (/^[0-9]$/.test(e.key)) keys.current.add(e.key);
      else if (e.key === 'Backspace') keys.current.drop();
      else if (e.key === 'Enter') void keys.current.ok();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const hint = p.note && p.note !== 'code-off' ? NOTE_WORDS[p.note].text : undefined;
  return (
    <div className="lock">
      <div className="lk-mark">{I.brand()}</div>
      <p className="eb lk-eb" style={{ marginBottom: hint ? 18 : 34 }}>Locked</p>
      {hint && <p className="lk-hint" style={{ margin: p.note === 'damaged' ? 0 : '0 0 26px' }}>{hint}</p>}
      {p.note === 'damaged' && <RestoreLink busy={p.busy} onRestore={p.onRestore} style={{ margin: '4px 0 18px' }} />}
      <CodePad count={count} bio={p.bio} fading={fading} busy={p.busy} label="Open"
        onDigit={add} onDelete={drop} onOk={() => void ok()} onBio={() => void lock.unlock({ mode: 'fingerprint' })} />
      <button type="button" className="btn btn--text lk-alt" data-a="lockpass" onClick={p.onPassphrase}>Use your passphrase</button>
    </div>
  );
}
