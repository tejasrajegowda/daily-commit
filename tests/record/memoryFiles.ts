import type { SnapshotFiles } from '../../src/record/files.ts';

/** The private files in memory, with a log of every call and a way to make calls fail. */
export function memoryFiles() {
  const store = new Map<string, Uint8Array>();
  const log: string[] = [];
  let failing: string | undefined;
  let failError: (call: string) => Error = call => new Error(`injected failure: ${call}`);
  const step = (call: string) => {
    log.push(call);
    if (failing !== undefined && call.startsWith(failing)) throw failError(call);
  };
  const files: SnapshotFiles = {
    async write(path, bytes) { step(`write ${path}`); store.set(path, bytes.slice()); },
    async read(path) { step(`read ${path}`); return store.get(path)?.slice(); },
    async rename(from, to) {
      step(`rename ${from} ${to}`);
      const bytes = store.get(from);
      if (!bytes) throw new Error(`no file ${from}`);
      store.delete(from);
      store.set(to, bytes);
    },
    async list(dir) {
      step(`list ${dir}`);
      return [...store.keys()].filter(p => p.startsWith(`${dir}/`) && !p.slice(dir.length + 1).includes('/')).map(p => p.slice(dir.length + 1));
    },
    async remove(path) { step(`remove ${path}`); store.delete(path); },
  };
  /** every call whose text starts with `prefix` fails, until it is set to undefined */
  const failOn = (prefix: string | undefined, error?: (call: string) => Error) => {
    failing = prefix;
    if (error) failError = error;
  };
  return { files, store, log, failOn };
}
