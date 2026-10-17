// The byte forms a canary is searched in. Written here because the seed test searches the backup
// with it; Task 8b adds the tar reader and this file's own tests. The forms are Task 8b's.
import { Buffer } from 'node:buffer';

export type Form = 'utf8' | 'utf16le' | 'utf16be' | 'base64' | 'base64url';

export interface CanaryForm { readonly form: Form; readonly bytes: Uint8Array }

/** UTF-8, UTF-16 both ways, and base64 / base64url at each of the three alignments. Duplicates dropped. */
export function canaryForms(canary: string): CanaryForm[] {
  const utf8 = Buffer.from(canary, 'utf8');
  const le = Buffer.from(canary, 'utf16le');
  const out: CanaryForm[] = [
    { form: 'utf8', bytes: utf8 },
    { form: 'utf16le', bytes: le },
    { form: 'utf16be', bytes: Buffer.from(le).swap16() },
  ];
  const seen = new Set<string>();
  const add = (form: Form, bytes: Buffer) => {
    const key = `${form}\0${bytes.toString('latin1')}`;
    if (seen.has(key) || bytes.length === 0) return;
    seen.add(key);
    out.push({ form, bytes });
  };
  const len = utf8.length;
  for (const k of [0, 1, 2]) {
    const b64 = Buffer.concat([Buffer.alloc(k), utf8]).toString('base64');
    const slice = b64.slice(4 * Math.ceil(k / 3), 4 * Math.floor((k + len) / 3));
    add('base64', Buffer.from(slice, 'latin1'));
    add('base64url', Buffer.from(slice.replaceAll('+', '-').replaceAll('/', '_'), 'latin1'));
  }
  return out;
}

export interface Hit { readonly canary: string; readonly form: Form; readonly at: number }

/** Every occurrence of every form, from the byte after the last hit. */
export function canaryHits(bytes: Uint8Array, canaries: readonly string[]): Hit[] {
  const hay = Buffer.from(bytes);
  const hits: Hit[] = [];
  for (const canary of canaries) {
    for (const form of canaryForms(canary)) {
      const needle = Buffer.from(form.bytes);
      let from = 0;
      for (;;) {
        const at = hay.indexOf(needle, from);
        if (at < 0) break;
        hits.push({ canary, form: form.form, at });
        from = at + 1;
      }
    }
  }
  return hits;
}
