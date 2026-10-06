import { useRef, useState } from 'react';
import { resultWords, useApp, useHeld, useModel, useNav, useSaveAtLeave } from '../app/context.ts';
import { setSetting } from '../record/ops/settings.ts';
import { I } from '../ui/icons.tsx';
import { SUPPORT_WORDS as W } from './settingsWords.ts';

// Support: always in the same place, never highlighted, never triggered by anything logged. The
// helplines, someone you trust and a note for a bad night, both kept under the words key and shown
// only here. The app never contacts anyone. A note whose save didn't go through is held for the
// visit and comes back in its field; one still being written when the app is left is saved before the lock.

const HELD = 'support:badNightNote';

export function Support() {
  const { store } = useApp();
  const held = useHeld();
  const model = useModel();
  const { go } = useNav();
  const kept = held.get(HELD);
  const [editingContact, setEditingContact] = useState(false);
  const [contact, setContact] = useState<string | undefined>(undefined);
  const [note, setNote] = useState<string | undefined>(undefined);
  const [problem, setProblem] = useState<string | undefined>(undefined);
  const noteField = useRef<HTMLTextAreaElement>(null);
  useSaveAtLeave(noteField, () => keepNote());
  if (!model) return null;
  const s = model.settings;
  const noteNow = note ?? kept?.text ?? s.badNightNote ?? '';
  const keepNote = () => {
    if (noteNow.trim() === (s.badNightNote ?? '')) held.drop(HELD);
    else void held.keep(HELD, noteNow, () => store.run(c => setSetting(c, 'badNightNote', noteNow.trim())));
  };
  const save = async (name: 'contact', value: string) => {
    const r = await store.run(c => setSetting(c, name, value.trim()));
    setProblem(resultWords(r)?.text);
    return r.kind === 'Saved';
  };

  return (
    <div className="scr">
      <main className="col" style={{ maxWidth: 560, margin: '0 auto', width: '100%' }}>
        <button type="button" className="btn btn--text" data-a="support-back" onClick={() => go('settings', 'support')} style={{ paddingLeft: 0, gap: 4 }}>
          <span style={{ display: 'inline-flex', width: 18, height: 18 }}>{I.back()}</span>Settings
        </button>
        <h1 className="t-l" style={{ margin: '10px 0 6px' }}>Support</h1>
        <p className="meta" style={{ margin: '0 0 20px' }}>{W.intro}</p>
        <div className="stack support">
          <div className="panel">
            <p className="eb">{W.manas}</p>
            <div className="phone-n" style={{ marginTop: 10 }}><a href="tel:14416">14416</a></div>
            <div className="meta" style={{ marginTop: 4 }}>or <a href="tel:18008914416">1-800-891-4416</a></div>
          </div>
          <div className="panel"><p className="eb">Anywhere else</p><p className="body" style={{ margin: '8px 0 0' }}>{W.elsewhere}</p></div>
          <div className="panel" data-a="trusted">
            <p className="eb">Someone you trust</p>
            <p className="body" style={{ margin: '8px 0 12px' }}>{W.trusted}</p>
            {s.contact && !editingContact && <p className="body" data-a="contact" style={{ margin: '0 0 12px', color: 'var(--ink-1)' }}>{s.contact}</p>}
            {editingContact
              ? <form onSubmit={e => { e.preventDefault(); void save('contact', contact ?? '').then(ok => ok && setEditingContact(false)); }}>
                  <input className="inp" aria-label="A name and number" placeholder="A name and number" value={contact ?? s.contact ?? ''} autoComplete="off" onChange={e => setContact(e.currentTarget.value)} />
                  <button type="submit" className="btn btn--ghost" data-a="contact-save" style={{ marginTop: 12 }}>Keep it here</button>
                </form>
              : <button type="button" className="btn btn--ghost" data-a="contact-edit" onClick={() => { setContact(s.contact ?? ''); setEditingContact(true); }}>{s.contact ? 'Change it' : 'Add a name and number'}</button>}
          </div>
          <div className="panel">
            <p className="eb">A note for a bad night</p>
            <textarea ref={noteField} className="field" rows={3} style={{ marginTop: 12 }} data-a="badnight" aria-label="A note for a bad night" placeholder={W.notePlaceholder}
              value={noteNow} onChange={e => setNote(e.currentTarget.value)} onBlur={keepNote} />
            <p className="meta" style={{ margin: '10px 4px 0' }}>{W.noteMeta}</p>
            {kept && <p className="meta" data-a="badnight-problem" style={{ margin: '10px 4px 0' }}>{kept.note.text}</p>}
          </div>
          {problem && <p className="meta" data-a="support-problem">{problem}</p>}
        </div>
      </main>
    </div>
  );
}
