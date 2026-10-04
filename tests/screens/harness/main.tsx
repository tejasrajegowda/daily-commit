// The harness page: the state from the URL, a fresh invented record, then the app.
import { createRoot } from 'react-dom/client';
import { openDb } from '../../../src/record/db.ts';
import '../../../src/ui/fonts.css';
import '../../../src/ui/app.css';
import { seedRecord } from './seed.ts';
import { readState } from './state.ts';

const DB_NAME = 'daily-commit-harness';

/** What the flows can ask of the page. */
export interface HarnessControls {
  leave(): Promise<void>;
  resume(): Promise<void>;
}

declare global {
  interface Window { harness?: HarnessControls }
}

async function deleteDb(name: string): Promise<void> {
  await new Promise<void>((done, failed) => {
    const req = indexedDB.deleteDatabase(name);
    req.onsuccess = () => done();
    req.onerror = () => failed(req.error);
    req.onblocked = () => done();
  });
}

async function start(): Promise<void> {
  const state = readState(location.hash);
  await deleteDb(DB_NAME);
  const db = openDb({ name: DB_NAME, indexedDB, IDBKeyRange });
  if (state.screen !== 'first' && state.screen !== 'restore') await seedRecord(db, state);
  window.harness = { leave: async () => {}, resume: async () => {} };
  const root = document.getElementById('root');
  if (!root) throw new Error('harness: #root is missing');
  createRoot(root).render(<main className="app" data-harness-ready="" aria-label="Daily Commit" />);
}

window.addEventListener('hashchange', () => location.reload());
void start();
