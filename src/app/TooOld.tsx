import { I } from '../ui/icons.tsx';
import { TOO_OLD_WORDS as W } from './tooOldWords.ts';

export function TooOld({ version }: { readonly version: string }) {
  return (
    <div className="center-col first" data-a="too-old">
      <div className="fr-mark">{I.brand()}</div>
      <h1 className="t-l" style={{ marginTop: 8 }}>{W.title}</h1>
      <p className="body" style={{ margin: '12px 0 0' }}>{W.text}</p>
      <p className="meta" style={{ margin: '16px 0 0' }}>{W.fix}</p>
      <p className="meta" style={{ margin: '16px 0 0' }}>{W.version(version)}</p>
    </div>
  );
}
