import { useEffect, useRef, useState } from 'react';
import { readBackupFile, restoreWith, useApp, type RestoreMessage, type Secret } from '../app/context.ts';
import { I } from '../ui/icons.tsx';
import type { FoundCopy } from './FirstRun.tsx';
import { madeAtWords, RESTORE_WORDS } from './restoreWords.ts';

// Restore from a backup. The file and the secret are checked first; if this phone already holds a
// record, the person is asked before anything is replaced, and told when the file is from a
// different record. The secret waits for that answer in a ref, never in state, and goes when the
// screen does.

export interface RestoreProps {
  /** this phone already holds a record (restore was opened from Settings) */
  readonly replacing: boolean;
  /** a file already chosen: the copy Android put back */
  readonly preset?: FoundCopy;
  /** Back, Leave it, or Open after Restored */
  onClose(outcome: 'back' | 'restored'): void;
}

const tz = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

function Note({ title, text }: { readonly title: string; readonly text: string }) {
  return <div className="panel note" data-a="restore-note"><p className="eb">{title}</p><p className="body" style={{ margin: '8px 0 0' }}>{text}</p></div>;
}

function Back({ label, onClick, disabled = false }: { readonly label: string; onClick(): void; readonly disabled?: boolean }) {
  return (
    <button type="button" className="btn btn--text" data-a="back" style={{ paddingLeft: 0, gap: 4, alignSelf: 'flex-start' }} disabled={disabled} onClick={onClick}>
      {I.back({ width: 18, height: 18 })}{label}
    </button>
  );
}

export function Restore(props: RestoreProps) {
  const deps = useApp();
  const [file, setFile] = useState<FoundCopy | undefined>(props.preset);
  const [method, setMethod] = useState<Secret['method']>('passphrase');
  const [message, setMessage] = useState<RestoreMessage | undefined>(undefined);
  const [step, setStep] = useState<'pick' | 'ask' | 'done'>('pick');
  const [other, setOther] = useState(false);
  const [busy, setBusy] = useState(false);
  const secret = useRef<Secret | undefined>(undefined);
  const field = useRef<HTMLInputElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  useEffect(() => () => { secret.current = undefined; }, []);

  const backLabel = props.replacing ? 'Settings' : 'Back';
  const close = (outcome: 'back' | 'restored') => {
    secret.current = undefined;
    props.onClose(outcome);
  };

  const attempt = async (s: Secret, replace: boolean) => {
    if (!file) return;
    setBusy(true);
    try {
      const result = await restoreWith(deps, file.bytes, s, replace);
      if (result.kind === 'Restored') {
        secret.current = undefined;
        setStep('done');
      } else if (result.kind === 'Ask') {
        secret.current = s;
        setOther(result.otherRecord);
        setStep('ask');
      } else {
        secret.current = undefined;
        setMessage(result.message);
        setStep('pick');
      }
    } finally {
      setBusy(false);
    }
  };

  const onRestore = () => {
    const el = field.current;
    if (!el || !file || busy) return;
    const text = el.value;
    el.value = '';
    if (text.trim()) void attempt({ method, text }, false);
  };

  const onFile = async (chosen: File | undefined) => {
    if (!chosen) return;
    const read = readBackupFile(new Uint8Array(await chosen.arrayBuffer()));
    if (read.kind === 'File') {
      setFile({ bytes: read.bytes, madeAt: read.madeAt });
      setMessage(undefined);
    } else {
      setFile(undefined);
      setMessage(read.kind === 'Newer' ? 'newer' : 'damaged');
    }
  };

  const made = file ? madeAtWords(file.madeAt, tz()) : '';

  if (step === 'done') {
    return (
      <div className="center-col first">
        <div className="fr-mark">{I.brand()}</div>
        <h1 className="t-l" style={{ marginTop: 6 }}>Restored</h1>
        <p className="body" style={{ margin: '12px 0 0' }}>Your record is back as it was on {made}. Open it with your passphrase.</p>
        {deps.device.deviceModes
          ? <p className="meta" style={{ margin: '12px 0 26px' }}>After that, Settings → Privacy sets up your phone's lock or your own code again.{props.replacing ? ' They were switched off, because they belonged to the record that was here before.' : ''}</p>
          : <div style={{ height: 26 }} />}
        <button type="button" className="btn btn--primary wide" data-a="open" onClick={() => close('restored')}>Open</button>
      </div>
    );
  }

  if (step === 'ask') {
    return (
      <div className="center-col first">
        {/* nothing stops a replace once it runs, so leaving is closed until it ends, like "Leave it" */}
        <Back label={backLabel} disabled={busy} onClick={() => close('back')} />
        <h1 className="t-l" style={{ marginTop: 14 }}>Replace everything on this phone?</h1>
        <p className="body" style={{ margin: '12px 0 0' }}>This phone already holds a record. Restoring replaces all of it with the backup made on {made}. There is no merging.</p>
        {other && <div style={{ marginTop: 14 }}><Note {...RESTORE_WORDS.other} /></div>}
        <p className="meta" style={{ margin: '16px 0 22px' }}>A copy of what's here now is kept on this phone for 7 days, in case.</p>
        <div className="two">
          <button type="button" className="btn btn--secondary" data-a="leave" disabled={busy} onClick={() => close('back')}>Leave it</button>
          <button type="button" className="btn btn--secondary" data-a="replace" disabled={busy}
            onClick={() => { const s = secret.current; if (s) void attempt(s, true); }}>Replace everything</button>
        </div>
      </div>
    );
  }

  return (
    <div className="center-col first">
      <Back label={backLabel} onClick={() => close('back')} />
      <h1 className="t-l" style={{ marginTop: 14 }}>Restore from a backup</h1>
      <p className="body" style={{ margin: '12px 0 18px' }}>A backup file opens with the passphrase that was in use when it was made, or with your recovery code.</p>
      <div className="panel file-row">
        <p className="eb">Backup</p>
        <p className="body" style={{ margin: '6px 0 0' }}>{file ? `Made ${made}` : 'No file chosen yet'}</p>
        <button type="button" className="btn btn--text" data-a="choose" style={{ paddingLeft: 0, marginTop: 4 }} onClick={() => picker.current?.click()}>{file ? 'Choose another file' : 'Choose a file'}</button>
        <input ref={picker} type="file" hidden onChange={e => { void onFile(e.currentTarget.files?.[0]); e.currentTarget.value = ''; }} />
      </div>
      <form onSubmit={e => { e.preventDefault(); onRestore(); }}>
        <input ref={field} key={method} className="pass" type="password" placeholder={method === 'passphrase' ? 'Passphrase' : 'Recovery code'}
          aria-label={method === 'passphrase' ? 'Passphrase' : 'Recovery code'} style={{ marginTop: 18 }}
          autoComplete="off" autoCapitalize="off" autoCorrect="off" spellCheck={false} disabled={busy} />
      </form>
      {message && <div style={{ margin: '14px 0 0' }}><Note {...RESTORE_WORDS[message]} /></div>}
      <button type="button" className="btn btn--primary wide" data-a="restore-go" style={{ marginTop: 18 }} disabled={busy}
        onClick={file ? onRestore : () => picker.current?.click()}>{busy ? 'Checking…' : 'Restore'}</button>
      <button type="button" className="btn btn--text wide" data-a="method" style={{ marginTop: 6 }}
        onClick={() => setMethod(method === 'passphrase' ? 'recovery' : 'passphrase')}>{method === 'passphrase' ? 'Use the recovery code instead' : 'Use the passphrase instead'}</button>
    </div>
  );
}
