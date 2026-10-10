import type { PluginListenerHandle } from '@capacitor/core';
import type { DeviceInfo, DevicePort, Picked } from '../app/context.ts';
import type { SnapshotFiles } from '../record/files.ts';
import { fromBase64url, toBase64url } from '../vault/encoding.ts';
import type { CodeCheck, DeviceMode, NativeOpen, VaultPlugin } from '../vault/plugin.ts';

// The phone. The app reaches Android only through here: the Vault plugin (the device copies), the
// Shell plugin (leaving, the cover, the private files, "save as", the picker, the notification
// permission, the uptime clock, the timing line, what the phone is) and @capacitor/app for Back.
// The plugins come in as plain objects, so tests drive this with stand-ins; android.ts hands in
// the real ones. Each call's shape is the one the Java side answers (Tasks 3b and 4b).

/** The Vault plugin as the bridge carries it: one object per call. */
export interface VaultBridge {
  status(): Promise<{ readonly modes: DeviceMode[]; readonly codeKey?: string | null }>;
  enrol(o: { mode: DeviceMode; masterKey: string; code?: string }): Promise<void>;
  unwrap(o: { mode: 'phone-lock' | 'fingerprint' }): Promise<NativeOpen>;
  verifyCode(o: { code: string }): Promise<CodeCheck>;
  remove(o: { mode: DeviceMode }): Promise<void>;
}

/** The Shell plugin's calls and events (Task 4b's contract). */
export interface ShellBridge {
  addListener(event: 'leave' | 'resume', cb: () => void): Promise<PluginListenerHandle>;
  drawn(): Promise<void>;
  writeFile(o: { path: string; data: string }): Promise<void>;
  readFile(o: { path: string }): Promise<{ readonly data: string | null }>;
  renameFile(o: { from: string; to: string }): Promise<void>;
  listFiles(o: { dir: string }): Promise<{ readonly names: string[] }>;
  removeFile(o: { path: string }): Promise<void>;
  saveFile(o: { name: string; data: string }): Promise<{ readonly saved: boolean }>;
  pickFile(): Promise<{ readonly kind: 'Picked'; readonly data: string } | { readonly kind: 'Cancelled' } | { readonly kind: 'TooLarge' }>;
  notificationsAllowed(): Promise<{ readonly allowed: boolean }>;
  askNotifications(): Promise<{ readonly allowed: boolean }>;
  sleep(o: { ms: number }): Promise<void>;
  timing(o: { label: string; ms: number }): Promise<void>;
  info(): Promise<DeviceInfo>;
}

/** The two calls of @capacitor/app this app uses. */
export interface AppBridge {
  addListener(event: 'backButton', cb: () => void): Promise<PluginListenerHandle>;
  minimizeApp(): Promise<void>;
}

export interface Bridges {
  readonly vault: VaultBridge;
  readonly shell: ShellBridge;
  readonly app: AppBridge;
  /** runs `then` once a frame has been drawn; two animation frames by default */
  readonly afterPaint?: (then: () => void) => void;
  /** navigator.storage.persist() by default */
  readonly persist?: () => Promise<boolean>;
}

/** The Shell's wait is 0 to 60 s, whole milliseconds. */
export const MAX_SLEEP_MS = 60_000;

const codeOf = (e: unknown): unknown => (typeof e === 'object' && e !== null ? (e as { code?: unknown }).code : undefined);

/** A full phone comes back as the error the record already knows (record/core.ts isQuotaFull). */
async function fileCall<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (e) {
    throw codeOf(e) === 'full' ? Object.assign(new Error('The phone is full.'), { name: 'QuotaExceededError' }) : e;
  }
}

const twoFrames = (then: () => void) => { requestAnimationFrame(() => requestAnimationFrame(then)); };

export function androidPortWith(b: Bridges): DevicePort {
  const { vault, shell, app } = b;
  const afterPaint = b.afterPaint ?? twoFrames;
  const stopOn = (handle: Promise<PluginListenerHandle>) => () => { void handle.then(h => h.remove()); };

  const plugin: VaultPlugin = {
    status: async () => ({ modes: (await vault.status()).modes }),
    enrol: (mode, masterKey, code) => vault.enrol(code === undefined ? { mode, masterKey } : { mode, masterKey, code }),
    unwrap: mode => vault.unwrap({ mode }),
    verifyCode: code => vault.verifyCode({ code }),
    remove: mode => vault.remove({ mode }),
  };

  const files: SnapshotFiles = {
    write: (path, bytes) => fileCall(() => shell.writeFile({ path, data: toBase64url(bytes) })),
    async read(path) {
      const { data } = await fileCall(() => shell.readFile({ path }));
      return data === null ? undefined : fromBase64url(data);
    },
    rename: (from, to) => fileCall(() => shell.renameFile({ from, to })),
    list: async dir => [...(await fileCall(() => shell.listFiles({ dir }))).names],
    remove: path => fileCall(() => shell.removeFile({ path })),
  };

  return {
    plugin,
    deviceModes: true,
    files,
    onLeave: cb => stopOn(shell.addListener('leave', cb)),
    // the cover over the web view goes only once the blank or lock screen has really been drawn (C9)
    onResume: cb => stopOn(shell.addListener('resume', () => {
      cb();
      afterPaint(() => { void shell.drawn().catch(() => {}); });
    })),
    saveFile: async (name, bytes) => (await shell.saveFile({ name, data: toBase64url(bytes) })).saved,
    async pickFile(): Promise<Picked> {
      const got = await shell.pickFile();
      return got.kind === 'Picked' ? { kind: 'Picked', bytes: fromBase64url(got.data) } : got;
    },
    spaceUsed: async () => (await navigator.storage?.estimate?.())?.usage,
    persist: b.persist ?? (async () => (await navigator.storage?.persist?.()) ?? false),
    sleep: ms => shell.sleep({ ms: Math.min(MAX_SLEEP_MS, Math.max(0, Math.round(ms))) }),
    timing: (label, ms) => { void shell.timing({ label, ms: Math.max(0, Math.round(ms)) }).catch(() => {}); },
    info: () => shell.info(),
    onBack: cb => stopOn(app.addListener('backButton', cb)),
    leaveApp: () => { void app.minimizeApp().catch(() => {}); },
  };
}
