import { I } from './icons.tsx';

// The keypad for an own code: six dots to start, more appear past six, and the button shows once
// six digits are in. It only draws: the digits themselves are kept by the screen, never here.

export interface CodePadProps {
  readonly count: number;
  /** the fingerprint key, while the fingerprint's copy exists */
  readonly bio: boolean;
  readonly fading?: boolean;
  readonly busy?: boolean;
  readonly label: string;
  onDigit(digit: string): void;
  onDelete(): void;
  onOk(): void;
  onBio?(): void;
}

export const MIN_DIGITS = 6;
export const MAX_DIGITS = 12;

export function CodePad(p: CodePadProps) {
  return (
    <>
      <div className={p.fading ? 'pins fading' : 'pins'}>
        {Array.from({ length: Math.max(MIN_DIGITS, p.count) }, (_, i) => <i key={i} className={i < p.count ? 'on' : ''} />)}
      </div>
      <div className="pad">
        {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map(k => <button key={k} type="button" data-a="pin" data-x={k} onClick={() => p.onDigit(k)}>{k}</button>)}
        {p.bio
          ? <button type="button" className="k-bio" data-a="bio" aria-label="Use fingerprint" onClick={() => p.onBio?.()}>{I.finger()}</button>
          : <span />}
        <button type="button" data-a="pin" data-x="0" onClick={() => p.onDigit('0')}>0</button>
        <button type="button" className="k-sm" data-a="unpin" aria-label="Delete" onClick={p.onDelete}>{I.del()}</button>
      </div>
      <button type="button" className="btn btn--primary lk-ok" data-a="pinok" disabled={p.count < MIN_DIGITS || p.busy} onClick={p.onOk}>{p.busy ? 'Opening…' : p.label}</button>
    </>
  );
}
