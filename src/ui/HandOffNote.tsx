/** The once-only note after Android cut a hand-off short: what didn't happen, "Leave it", and a way to try again, at the same weight. */
export function HandOffNote(p: { readonly kind: string; readonly title: string; readonly text: string; readonly leave: string; readonly again: string; onLeave(): void; onAgain(): void }) {
  return (
    <div className="panel note cut-note" data-a="handoff" data-x={p.kind}>
      <p className="eb">{p.title}</p>
      <p className="body" style={{ margin: '8px 0 0' }}>{p.text}</p>
      <div className="two" style={{ marginTop: 12 }}>
        <button type="button" className="btn btn--secondary" data-a="handoff-x" onClick={p.onLeave}>{p.leave}</button>
        <button type="button" className="btn btn--secondary" data-a="handoff-go" onClick={p.onAgain}>{p.again}</button>
      </div>
    </div>
  );
}
