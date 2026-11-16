import { I } from '../ui/icons.tsx';
import { START_FAILED_WORDS as W } from './startFailedWords.ts';

export function StartFailed({ version, step, error }: { readonly version: string; readonly step: string; readonly error: string }) {
  return (
    <div className="center-col first" data-a="start-failed">
      <div className="fr-mark">{I.brand()}</div>
      <h1 className="t-l" style={{ marginTop: 8 }}>{W.title}</h1>
      <p className="body" style={{ margin: '12px 0 0' }}>{W.text}</p>
      <p className="meta" style={{ margin: '16px 0 0' }}>{W.fix}</p>
      <p className="meta" style={{ margin: '16px 0 0' }}>{W.code(step, error)}</p>
      <p className="meta" style={{ margin: '4px 0 0' }}>{W.version(version)}</p>
    </div>
  );
}
