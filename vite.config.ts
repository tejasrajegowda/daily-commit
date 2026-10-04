import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// `base: './'` keeps every asset path relative — Capacitor serves the build from inside the APK.
// Tests do not run through Vite: a '#' anywhere in the checkout path is read as a URL fragment
// by Vite's module loader, so tests use Node's own runner (see package.json). For the same reason
// Vite's dev server can't serve the app here: `npm run watch` rebuilds on every save and
// `npm run preview` serves the build.
export default defineConfig({
  plugins: [react()],
  base: './',
  build: {
    outDir: 'dist',
    // no source maps in the shipped app: nothing to help a stranger read the bundle on the phone
    sourcemap: false,
  },
});
