import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canaryForms, canaryHits } from '../../scripts/android/checks/canary.ts';
import { tarEntries } from '../../scripts/android/checks/tar.ts';

const C = 'CANARY-L2-DIARY-7QX4M';
const noise = (n: number) => Uint8Array.from({ length: n }, (_, i) => (i * 37 + 11) % 251);
const join = (...parts: Uint8Array[]) => { const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0)); let at = 0; for (const p of parts) { out.set(p, at); at += p.length; } return out; };

test('a canary is found in every form it can be stored in, at every base64 alignment', () => {
  const forms = canaryForms(C);
  for (const f of ['utf8', 'utf16le', 'utf16be', 'base64', 'base64url'] as const) assert.ok(forms.some(x => x.form === f), f);
  for (const k of [0, 1, 2]) {
    const b64 = Buffer.from(join(new Uint8Array(k), Buffer.from(C))).toString('base64');
    const hits = canaryHits(join(noise(50), Buffer.from(b64), noise(50)), [C]);
    assert.ok(hits.some(h => h.form === 'base64'), `alignment ${k}`);
  }
  assert.ok(canaryHits(join(noise(9), Buffer.from(C, 'utf16le'), noise(9)), [C]).some(h => h.form === 'utf16le'));
  assert.ok(canaryHits(join(noise(9), Buffer.from(C, 'utf16le').swap16(), noise(9)), [C]).some(h => h.form === 'utf16be'));
});

test('nothing is found where it isn\'t, and every place it is, is reported', () => {
  assert.deepEqual(canaryHits(noise(5000), [C]), []);
  const twice = join(Buffer.from(C), noise(20), Buffer.from(C));
  assert.equal(canaryHits(twice, [C]).filter(h => h.form === 'utf8').length, 2);
});

test('a tar\'s regular files, with ustar prefixes', () => {
  const header = (name: string, size: number, prefix = '') => {
    const h = new Uint8Array(512);
    h.set(Buffer.from(name), 0);
    h.set(Buffer.from(size.toString(8).padStart(11, '0')), 124);
    h[156] = '0'.charCodeAt(0);
    h.set(Buffer.from('ustar'), 257);
    h.set(Buffer.from(prefix), 345);
    return h;
  };
  const body = (n: number) => new Uint8Array(Math.ceil(n / 512) * 512);
  const tar = join(header('_manifest', 10, 'apps/app.dailycommit'), body(10), header('f/backup/latest.dcbak', 700, 'apps/app.dailycommit'), body(700), new Uint8Array(1024));
  assert.deepEqual(tarEntries(tar), [{ name: 'apps/app.dailycommit/_manifest', size: 10 }, { name: 'apps/app.dailycommit/f/backup/latest.dcbak', size: 700 }]);
});
