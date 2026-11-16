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

  // device/ is the one boundary to the phone: Capacitor, itself, and only the types it serves.
  // and the base64url the bridge carries bytes in (pure, no secret)
  const DEVICE_MAY_IMPORT = new Set(['app/context.ts', 'record/files.ts', 'vault/plugin.ts', 'vault/encoding.ts']);
  function deviceBreaks(file: string, src: string): string[] {
    return specsIn(src).filter(spec => {
      if (spec.startsWith('@capacitor/')) return false;
      if (!spec.startsWith('.')) return true;
      const to = relative(SRC, join(file, '..', spec)).split(sep).join('/');
      return !(to.startsWith('device/') || DEVICE_MAY_IMPORT.has(to));
    }).map(spec => `imports ${spec}`);
  }

  it('device/ imports only Capacitor, itself, and the types it serves', () => {
    const sample = join(SRC, 'device', 'sample.ts');
    assert.deepEqual(deviceBreaks(sample, "import { openModel } from '../record/read.ts';\nimport x from 'left-pad';\nimport type { DevicePort } from '../app/context.ts';"),
      ['imports ../record/read.ts', 'imports left-pad']);
    for (const f of all.filter(f => area(f) === 'device')) assert.deepEqual(deviceBreaks(f, readFileSync(f, 'utf8')), [], relative(SRC, f));
  });

  it('capacitor.config.ts names Capacitor only as a type', () => {
    const src = readFileSync(join(SRC, '..', 'capacitor.config.ts'), 'utf8');
    const lines = src.split('\n').filter(l => /^\s*import\b/.test(l));
    assert.deepEqual(lines, ["import type { CapacitorConfig } from '@capacitor/cli';"]);
  });

  it('vault/ sits below the record: it imports only itself, and no library', () => {
    for (const f of all.filter(f => area(f) === 'vault')) {
      for (const spec of imports(f)) {
        const t = target(f, spec);
        assert.ok(t === 'vault', `${relative(SRC, f)} imports ${spec}`);
      }
    }
  });

  it('app/ is the top: rules/, record/ and vault/ never import it', () => {
    for (const f of all.filter(f => ['rules', 'record', 'vault'].includes(area(f)))) {
      for (const spec of imports(f)) assert.ok(target(f, spec) !== 'app', `${relative(SRC, f)} imports ${spec}`);
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

  it('features never import vault/, and reach app/ only through app/context.ts', () => {
    for (const f of all.filter(f => FEATURES.includes(area(f)))) {
      for (const spec of imports(f)) {
        const t = target(f, spec);
        assert.ok(t !== 'vault', `${relative(SRC, f)} imports ${spec}`);
        if (t === 'app') assert.equal(relative(SRC, join(f, '..', spec)).split(sep).join('/'), 'app/context.ts', `${relative(SRC, f)} imports ${spec}`);
      }
    }
  });

  it('ui/ draws only: it imports only ui/ and React', () => {
    for (const f of all.filter(f => area(f) === 'ui')) {
      for (const spec of imports(f)) {
        const t = target(f, spec);
        assert.ok(t === 'ui' || spec === 'react' || spec.startsWith('react/') || spec.startsWith('react-dom'), `${relative(SRC, f)} imports ${spec}`);
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

// The change log (D-25) only grows: lines are added inside the core's own transactions and nowhere
// else, and no screen reads it (§8 #22: stored, never shown).
describe('the change log', () => {
  const rel = (f: string) => relative(SRC, f).split(sep).join('/');
  it('only the core and the logger write to it, and only by adding, except the trash\'s wipe', () => {
    for (const f of all) {
      const src = readFileSync(f, 'utf8');
      const writes = [...src.matchAll(/\.changes\.(put|add|bulkPut|bulkAdd|delete|bulkDelete|clear|modify|update)\b/g)].map(m => m[0]);
      // migrations add one line per batch in their own transaction (they run before unlock, outside the core's writes)
      if (rel(f) === 'record/migrations.ts') assert.deepEqual(writes, ['.changes.add'], 'migrations only add');
      // the log's one delete (D-33): the trash's wipe, in the write that wipes the item, called only by the core
      else if (rel(f) === 'record/changes.ts') assert.deepEqual(writes, ['.changes.bulkDelete'], 'the logger deletes only in the wipe');
      else assert.deepEqual(writes, [], `${rel(f)} writes to the change log`);
      if (/\bwipeLines\(/.test(src)) assert.ok(['record/core.ts', 'record/changes.ts'].includes(rel(f)), `${rel(f)} wipes log lines`);
      if (!['record/core.ts', 'record/changes.ts'].includes(rel(f))) {
        assert.ok(!/table:\s*'changes'/.test(src), `${rel(f)} puts rows into the change log`);
        assert.ok(!/table\(\s*['"]changes['"]\s*\)/.test(src), `${rel(f)} reaches the change log by name`);
      }
      // outside record/, nothing so much as names the table: screens can't read it for display (§8 #22)
      if (area(f) !== 'record') assert.ok(!/\.changes\b/.test(src), `${rel(f)} reaches the change log`);
    }
  });
  it('only the trash\'s sweep makes a page or a Not yet tombstone, since one wipes their words from the log (D-33)', () => {
    for (const f of all) {
      const src = readFileSync(f, 'utf8');
      const made = [...src.matchAll(/tombstone\(\s*(entryToParts|notYetToParts)\b/g)].length;
      if (rel(f) === 'record/ops/words.ts') {
        assert.equal(made, 2, 'the sweep tombstones pages and Not yet items');
        assert.ok(/export function sweepTrash[\s\S]*tombstone\(entryToParts[\s\S]*tombstone\(notYetToParts/.test(src), 'inside sweepTrash');
        assert.equal([...src.matchAll(/tombstone\(/g)].length, 2, 'and nowhere else in the file');
      } else assert.equal(made, 0, `${rel(f)} tombstones a page or a Not yet item`);
    }
  });
  it('only deleting a reminder makes its tombstone, since one wipes its words from the log (D-35)', () => {
    for (const f of all) {
      const src = readFileSync(f, 'utf8');
      const made = [...src.matchAll(/tombstone\(\s*cueToParts\b/g)].length;
      if (rel(f) === 'record/ops/cues.ts') {
        assert.equal(made, 1);
        assert.ok(/export function deleteCue[\s\S]*tombstone\(cueToParts/.test(src), 'inside deleteCue');
        assert.equal([...src.matchAll(/tombstone\(/g)].length, 1, 'and nowhere else in the file');
      } else assert.equal(made, 0, `${rel(f)} tombstones a reminder`);
    }
  });
  it('nothing outside record/ imports it', () => {
    for (const f of all.filter(f => area(f) !== 'record')) {
      for (const spec of imports(f)) assert.ok(!/\/changes\.ts$/.test(spec), `${rel(f)} imports ${spec}`);
    }
  });
});
