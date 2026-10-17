// Readers for Android's own dumps. The fixtures in tests/android/checks.test.ts are the contract;
// a real dump may add a shape the fixture already allows, and must not make a fixture fail.

const PKG = 'app.dailycommit';

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function stringExtra(block: string, key: string): string | undefined {
  const paren = new RegExp(`android\\.${key}=String \\(([^)]*)\\)`).exec(block);
  if (paren) return paren[1];
  const bracket = new RegExp(`android\\.${key}=String \\[([^\\]]*)]`).exec(block);
  return bracket?.[1];
}

/** Our app's posted notifications in `dumpsys notification --noredact`: their title and text (text '' when none). */
export function ourNotifications(dump: string, pkg = PKG): { readonly title: string; readonly text: string }[] {
  const pkgRe = new RegExp(`\\bpkg=${escapeRe(pkg)}(?:\\s|$)`);
  const out: { title: string; text: string }[] = [];
  for (const block of dump.split(/(?=NotificationRecord\()/)) {
    if (!pkgRe.test(block)) continue;
    out.push({ title: stringExtra(block, 'title') ?? '', text: stringExtra(block, 'text') ?? '' });
  }
  return out;
}

function windowExact(block: string): boolean {
  const token = /\bwindow=(\S+)/.exec(block)?.[1];
  return token === '0' || token === '0ms' || token === '+0ms' || token === '+0s0ms';
}

/** Our app's alarms in `dumpsys alarm`, and whether each is exact (window 0, not a prefix of a longer window). */
export function ourAlarms(dump: string, pkg = PKG): { readonly exact: boolean }[] {
  const pkgRe = new RegExp(`\\b${escapeRe(pkg)}\\b`);
  const out: { exact: boolean }[] = [];
  for (const block of dump.split(/(?=Alarm\{)/)) {
    if (!block.startsWith('Alarm{') || !pkgRe.test(block)) continue;
    out.push({ exact: windowExact(block) });
  }
  return out;
}

/** Whether a web view of this app offers a devtools socket (`/proc/net/unix`). Chrome's own socket is not this app's. */
export function devtoolsSocket(procNetUnix: string): boolean {
  return /@webview_devtools_remote_\d+/.test(procNetUnix);
}

/**
 * `closed` when the socket does not serve a page. `debug-image` when a userdebug or eng
 * image still serves one: WebView refuses to turn that off. `open` on any other image.
 */
export function devtoolsOnImage(buildType: string, serves: boolean): 'closed' | 'debug-image' | 'open' {
  if (!serves) return 'closed';
  if (buildType === 'userdebug' || buildType === 'eng') return 'debug-image';
  return 'open';
}

/** The resumed activity's component in `dumpsys activity activities`. */
export function resumedActivity(dump: string): string | undefined {
  return /mResumedActivity: ActivityRecord\{[^}]*?\s(\S+)\s+t\d+/.exec(dump)?.[1];
}

/** Our task's id in `dumpsys activity recents`. */
export function ourTaskId(dump: string, pkg = PKG): number | undefined {
  const m = new RegExp(`Task\\{[^}]*#(\\d+)\\b[^}]*\\b${escapeRe(pkg)}\\b`).exec(dump);
  return m?.[1] === undefined ? undefined : Number(m[1]);
}
