// Draws this device's display choices: contrast multiplies the surface ladder (`--k`), and dim at
// night lays a faint black veil over everything after 19:00, so black stays exactly black.

export function applyDisplay(display: { readonly contrast: number; readonly dim: boolean }): void {
  const root = document.documentElement;
  root.style.setProperty('--k', String(display.contrast));
  if (display.dim) root.dataset.dim = '';
  else delete root.dataset.dim;
}
