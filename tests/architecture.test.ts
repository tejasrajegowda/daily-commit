// The dependency rule, enforced by reading every import in src/.
// It is what keeps a redesign from ever touching your data: screens may use the rules and the
// record, but only `record/` talks to storage, `rules/` stays pure, and features never reach
// into each other.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const SRC = join(import.meta.dirname, '..', 'src');
const FEATURES = ['today', 'look-back', 'reviews', 'diary', 'plan', 'not-yet', 'settings', 'lock', 'first-run'];

function files(dir: string): string[] {
  return readdirSync(dir).flatMap(name => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? files(p) : /\.(ts|tsx)$/.test(name) ? [p] : [];
  });
}
function area(file: string): string {
  return relative(SRC, file).split(sep)[0] ?? '';
}
function specsIn(src: string): string[] {
  return [...src.matchAll(/(?:import|export)[^'"]*?from\s*['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/g)]
    .map(m => m[1] ?? m[2] ?? '');
}
function imports(file: string): string[] {
  return specsIn(readFileSync(file, 'utf8'));
}
// Backup code copies rows exactly as stored and never sees inside one: it may not import the
// plaintext read side, name what opens a single row, or reach for the session's row cipher.
const BACKUP_FORBIDDEN = /\b(?:openParts|openModel|rulesInput|RowCipher)\b|\.cipher\b/g;
function backupBreaks(file: string, src: string): string[] {
  const reads = specsIn(src).filter(s => s.startsWith('.') && relative(SRC, join(file, '..', s)).split(sep).join('/') === 'record/read.ts');
  return [...reads.map(s => `imports ${s}`), ...[...src.matchAll(BACKUP_FORBIDDEN)].map(m => `uses ${m[0]}`)];
}
// which top-level area of src/ a relative import lands in
function target(file: string, spec: string): string | null {
  if (!spec.startsWith('.')) return null;
  const parts = relative(SRC, join(file, '..', spec)).split(sep);
  return parts[0] === '..' ? null : (parts[0] ?? null);
}

const all = files(SRC);

describe('dependency rule', () => {
  it('rules/ is pure: it imports nothing outside itself, and no library', () => {
    for (const f of all.filter(f => area(f) === 'rules')) {
      for (const spec of imports(f)) {
        const t = target(f, spec);
        assert.ok(t === 'rules', `${relative(SRC, f)} imports ${spec}`);
      }
    }
  });

  it('only record/ imports Dexie (the one door to storage)', () => {
    for (const f of all.filter(f => area(f) !== 'record')) {
      for (const spec of imports(f)) assert.ok(!(spec === 'dexie' || spec.startsWith('dexie/')), `${relative(SRC, f)} imports ${spec}`);
    }
  });

  it('only device/ imports Capacitor (the one boundary to the phone)', () => {
    for (const f of all.filter(f => area(f) !== 'device')) {
      for (const spec of imports(f)) assert.ok(!spec.startsWith('@capacitor'), `${relative(SRC, f)} imports ${spec}`);
    }
  });

  it('vault/ sits below the record: it imports only itself, and no library', () => {
    for (const f of all.filter(f => area(f) === 'vault')) {
      for (const spec of imports(f)) {
        const t = target(f, spec);
        assert.ok(t === 'vault', `${relative(SRC, f)} imports ${spec}`);
      }
    }
  });

  it('features never import another feature', () => {
    for (const f of all.filter(f => FEATURES.includes(area(f)))) {
      for (const spec of imports(f)) {
        const t = target(f, spec);
        assert.ok(!(t !== null && FEATURES.includes(t) && t !== area(f)), `${relative(SRC, f)} imports ${spec}`);
      }
    }
  });

  it('backup code copies rows as stored: no plaintext read side, nothing that opens one row', () => {
    const sample = join(SRC, 'record', 'backup', 'sample.ts');
    assert.deepEqual(backupBreaks(sample, "import { openModel } from '../read.ts';\nconst c = s.cipher;"), ['imports ../read.ts', 'uses openModel', 'uses .cipher']);
    const backup = all.filter(f => relative(SRC, f).split(sep).slice(0, 2).join('/') === 'record/backup');
    assert.ok(backup.length > 0, 'no backup code found');
    for (const f of backup) assert.deepEqual(backupBreaks(f, readFileSync(f, 'utf8')), [], relative(SRC, f));
  });

  it('src/ has only the agreed top-level areas', () => {
    const allowed = new Set([...FEATURES, 'rules', 'record', 'vault', 'ui', 'device', 'app']);
    for (const f of all) {
      const a = area(f);
      if (a.includes('.')) continue; // top-level files such as main.tsx
      assert.ok(allowed.has(a), `unexpected area src/${a}`);
    }
  });
});
