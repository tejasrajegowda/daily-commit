import type { CapacitorConfig } from '@capacitor/cli';

// The Android app's shell. The app id, the scheme and the hostname make the web view's origin,
// https://localhost, and every stored row lives under that origin: changing any of them would leave
// the record unreachable after an update, so they never change. Nothing can inspect or log the web view.
const config: CapacitorConfig = {
  appId: 'app.dailycommit',
  appName: 'Daily Commit',
  webDir: 'dist',
  loggingBehavior: 'none',
  server: { androidScheme: 'https', hostname: 'localhost' },
  android: {
    webContentsDebuggingEnabled: false,
    loggingBehavior: 'none',
    allowMixedContent: false,
  },
};

export default config;
