/**
 * The app's private files, as the record uses them: snapshots and their temporary files. U5's
 * device/ keeps them on the phone; tests keep them in memory. Paths are relative and use "/".
 */
export interface SnapshotFiles {
  /** writes the whole file, replacing any file at that path */
  write(path: string, bytes: Uint8Array): Promise<void>;
  /** the whole file, or undefined if there is none */
  read(path: string): Promise<Uint8Array | undefined>;
  /** moves a file in one step, replacing any file at `to`, so `to` is never half-written */
  rename(from: string, to: string): Promise<void>;
  /** the names of the files directly inside a folder; empty if there is no such folder */
  list(dir: string): Promise<string[]>;
  remove(path: string): Promise<void>;
}
