// What a write tells the screen. A screen keeps what was typed until it hears Saved.

export type Refusal =
  | { readonly kind: 'Sealed' }
  | { readonly kind: 'Invalid'; readonly reason: string };

export type Result<T = void> =
  | { readonly kind: 'Saved'; readonly value: T }
  | Refusal
  | { readonly kind: 'QuotaFull' }
  | { readonly kind: 'Locked' };

export const saved = <T>(value: T): Result<T> => ({ kind: 'Saved', value });
export const sealed = (): Refusal => ({ kind: 'Sealed' });
export const invalid = (reason: string): Refusal => ({ kind: 'Invalid', reason });
export const quotaFull = <T>(): Result<T> => ({ kind: 'QuotaFull' });
export const locked = <T>(): Result<T> => ({ kind: 'Locked' });
