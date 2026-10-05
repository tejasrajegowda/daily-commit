import type { ReactNode } from 'react';
import { useModel, useNav } from './context.ts';
import { PAUSED_WORDS } from './pausedWords.ts';

// While tracking is paused, Today, Look back and the reviews show one quiet panel in place of the
// habits. Nothing is asked, counted or sent; the diary carries on. Pause in Settings turns it back on.

export function PausedGate({ title, children }: { readonly title: string; readonly children: ReactNode }) {
  const model = useModel();
  const { go } = useNav();
  if (model?.settings.paused !== true) return <>{children}</>;
  return (
    <div className="scr">
      <main className="col" style={{ maxWidth: 560, margin: '0 auto', width: '100%' }}>
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
