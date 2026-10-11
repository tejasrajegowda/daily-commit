import type { ReactNode } from 'react';
import { HandOffNote } from '../ui/HandOffNote.tsx';
import { againTo, HAND_OFF_WORDS, LEAVE_IT, useHandOff, useModel, useNav } from './context.ts';
import { PAUSED_WORDS } from './pausedWords.ts';

// While tracking is paused, Today, Look back and the reviews show one quiet panel in place of the
// habits. Nothing is asked, counted or sent; the diary carries on. Pause in Settings turns it back on.

export function PausedGate({ title, children }: { readonly title: string; readonly children: ReactNode }) {
  const model = useModel();
  const { go } = useNav();
  const cut = useHandOff();
  const note = cut.kind ? <HandOffNote kind={cut.kind} {...HAND_OFF_WORDS[cut.kind]} leave={LEAVE_IT} onLeave={cut.dismiss} onAgain={() => { const to = againTo(cut.kind!); cut.dismiss(); go(to.screen, to.variant); }} /> : null;
  if (model?.settings.paused !== true) return <>{children}</>;
  return (
    <div className="scr">
      <main className="col" style={{ maxWidth: 560, margin: '0 auto', width: '100%' }}>
        {note}
        <h1 className="t-l">{title}</h1>
        <div className="panel" data-a="paused" style={{ marginTop: 18 }}>
          <p className="eb">{PAUSED_WORDS.title}</p>
          <p className="body" style={{ margin: '8px 0 12px' }}>{PAUSED_WORDS.text}</p>
          <button type="button" className="btn btn--ghost" data-a="paused-settings" onClick={() => go('settings', 'pause')}>{PAUSED_WORDS.back}</button>
        </div>
      </main>
    </div>
  );
}
