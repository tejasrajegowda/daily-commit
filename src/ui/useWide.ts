import { useSyncExternalStore } from 'react';

// Whether the screen is wide enough for the laptop layout. The stylesheet switches at the same widths.

export const WIDE = '(min-width: 760px)';
export const WIDEST = '(min-width: 1100px)';

function matches(query: string): boolean {
  return typeof matchMedia === 'function' && matchMedia(query).matches;
}

export function useMedia(query: string): boolean {
  return useSyncExternalStore(
    change => {
      if (typeof matchMedia !== 'function') return () => {};
      const list = matchMedia(query);
      list.addEventListener('change', change);
      return () => list.removeEventListener('change', change);
    },
    () => matches(query),
  );
}

export const useWide = () => useMedia(WIDE);
