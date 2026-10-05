import type { DevicePort } from '../app/context.ts';
import type { SnapshotFiles } from '../record/files.ts';
import type { VaultPlugin } from '../vault/plugin.ts';

// The browser standing in for the phone, for building and checking the screens on a laptop. It has
// no device copies, so only the passphrase opens the record; its private files live in memory and
// go when the tab closes; and a hidden tab counts as leaving, so the app locks. The phone's own
// port arrives with the Android build.

const NONE = 'a browser holds no device copies';

const noDevice: VaultPlugin = {
  status: async () => ({ modes: [] }),
  enrol: () => Promise.reject(new Error(NONE)),
  unwrap: () => Promise.reject(new Error(NONE)),
  verifyCode: () => Promise.reject(new Error(NONE)),
  remove: async () => {},
};

/** The private files, in memory. */
export function memoryFiles(): SnapshotFiles {
  const store = new Map<string, Uint8Array>();
  return {
    async write(path, bytes) { store.set(path, bytes.slice()); },
    async read(path) { return store.get(path)?.slice(); },
    async rename(from, to) {
      const bytes = store.get(from);
      if (!bytes) throw new Error(`no file ${from}`);
      store.delete(from);
      store.set(to, bytes);
    },
    async list(dir) {
      return [...store.keys()].filter(p => p.startsWith(`${dir}/`) && !p.slice(dir.length + 1).includes('/')).map(p => p.slice(dir.length + 1));
    },
    async remove(path) { store.delete(path); },
  };
}

export function browserPort(): DevicePort {
  return {
    plugin: noDevice,
    deviceModes: false,
    files: memoryFiles(),
    onLeave(cb) {
      const hidden = () => { if (document.visibilityState === 'hidden') cb(); };
      document.addEventListener('visibilitychange', hidden);
      window.addEventListener('pagehide', cb);
      return () => {
        document.removeEventListener('visibilitychange', hidden);
        window.removeEventListener('pagehide', cb);
      };
    },
    onResume(cb) {
      const shown = () => { if (document.visibilityState === 'visible') cb(); };
      document.addEventListener('visibilitychange', shown);
      return () => document.removeEventListener('visibilitychange', shown);
    },
    // the browser's own download stands in for the phone's "save as"
    async saveFile(name, bytes) {
      const url = URL.createObjectURL(new Blob([bytes.slice()], { type: 'application/octet-stream' }));
      const a = Object.assign(document.createElement('a'), { href: url, download: name });
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
      return true;
    },
    async spaceUsed() {
      return (await navigator.storage?.estimate?.())?.usage;
    },
  };
}
