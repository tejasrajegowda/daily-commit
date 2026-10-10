import type { BackLayers, Nav, ScreenId } from './context.ts';

// Back on the phone, in C6's order: whatever is open on top (a sheet, the restore flow), then the
// screen's own way back, then Today, then leaving the app, which locks it.

export type BackStep =
  | { readonly kind: 'layer' }
  | { readonly kind: 'go'; readonly screen: ScreenId; readonly variant: string }
  | { readonly kind: 'leave' };

export interface BackPlace {
  readonly layers: number;
  /** the record is open and on screen (not the lock screen, first run or a flow) */
  readonly recordOpen: boolean;
  readonly nav: Nav;
}

const PARENT: Partial<Record<ScreenId, { readonly screen: ScreenId; readonly variant: string }>> = {
  secret: { screen: 'settings', variant: 'privacy' },
  support: { screen: 'settings', variant: '' },
};

export function backStep(p: BackPlace): BackStep {
  if (p.layers > 0) return { kind: 'layer' };
  if (!p.recordOpen) return { kind: 'leave' };
  const parent = PARENT[p.nav.screen];
  if (parent) return { kind: 'go', ...parent };
  if (p.nav.screen !== 'today') return { kind: 'go', screen: 'today', variant: '' };
  return { kind: 'leave' };
}

export function backLayers(): BackLayers {
  const stack: (() => void)[] = [];
  return {
    push(close) {
      stack.push(close);
      return () => {
        const at = stack.lastIndexOf(close);
        if (at >= 0) stack.splice(at, 1);
      };
    },
    size: () => stack.length,
    closeTop() { stack[stack.length - 1]?.(); },
  };
}
