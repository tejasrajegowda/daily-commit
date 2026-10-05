import { typedGroups } from './codeGroups.ts';

// Typing a recovery code back from paper: eight groups of five and the check symbol, drawn as they
// fill, over one invisible field that holds what was typed. It only draws; the screen keeps the text.

export function TypeBack({ typed, onChange, label = 'Recovery code, typed back' }: { readonly typed: string; onChange(text: string): void; readonly label?: string }) {
  const groups = typedGroups(typed);
  return (
    <div style={{ position: 'relative' }}>
      <div className="code well typeback" aria-hidden="true">
        {Array.from({ length: 9 }, (_, i) => {
          const done = groups.done[i];
          if (done !== undefined) return <span key={i} className="done">{done}</span>;
          const dots = i === 8 ? '·' : '·····';
          if (i === groups.done.length) return <span key={i} className="cur">{groups.current || <><i className="caret" /><span>{dots}</span></>}{groups.current && <i className="caret" />}</span>;
          return <span key={i}>{dots}</span>;
        })}
      </div>
      <input className="typeback-in" type="password" aria-label={label} value={typed} maxLength={60}
        autoComplete="off" autoCapitalize="characters" autoCorrect="off" spellCheck={false}
        style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', opacity: 0 }}
        onChange={e => onChange(e.currentTarget.value)} />
    </div>
  );
}
