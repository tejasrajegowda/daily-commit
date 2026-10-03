import type { SnapshotFiles } from '../files.ts';

// Private copies kept for a short while: the safety copy before "replace everything", and the raw
// copy before a schema upgrade. Neither folder is inside backup/, so Android's backup never carries
// them. At most two of each are kept, and each goes 7 days after it was made, so a wiped diary page
// can't outlive its promise in an old copy.

export const SAFETY = 'safety';
export const PREUPGRADE = 'preupgrade';
export const KEEP_COPIES = 2;
export const COPY_LIFE_MS = 7 * 86_400_000;
const NAME = /^(\d{13})\.[a-z.]+$/;

async function copiesIn(files: SnapshotFiles, dir: string): Promise<string[]> {
  return (await files.list(dir)).filter(name => NAME.test(name)).sort();
}

/** Keeps one copy, named by when it was made, through tmp/ and a rename; the oldest beyond two go. */
export async function keepCopy(files: SnapshotFiles, dir: string, nowMs: number, ext: string, bytes: Uint8Array): Promise<void> {
  const tmp = `tmp/${dir}.${ext}`;
  await files.write(tmp, bytes);
  await files.rename(tmp, `${dir}/${String(nowMs).padStart(13, '0')}.${ext}`);
  const names = await copiesIn(files, dir);
  for (const name of names.slice(0, Math.max(0, names.length - KEEP_COPIES))) await files.remove(`${dir}/${name}`);
}

/** Removes the copies made 7 days ago or more. */
export async function pruneCopies(files: SnapshotFiles, dir: string, nowMs: number): Promise<void> {
  for (const name of await copiesIn(files, dir)) {
    if (nowMs - Number(NAME.exec(name)?.[1]) >= COPY_LIFE_MS) await files.remove(`${dir}/${name}`);
  }
}
