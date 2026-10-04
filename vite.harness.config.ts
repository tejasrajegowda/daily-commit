import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The screen harness: a second entry page that draws the real app over an invented record, a fixed
// clock and a stand-in for the phone's lock, for the screen checks in scripts/screens/. It builds
// into dist-harness/ and never into the release build, whose only input stays index.html.
export default defineConfig({
  plugins: [react()],
  root: 'tests/screens/harness',
  base: './',
  publicDir: false,
  build: {
    outDir: '../../../dist-harness',
    emptyOutDir: true,
    sourcemap: false,
  },
});
