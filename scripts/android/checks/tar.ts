// Regular files in a ustar archive. Names join the prefix and the name field. A zero block ends it.

export interface TarEntry { readonly name: string; readonly size: number }

function text(block: Uint8Array, at: number, len: number): string {
  const slice = block.subarray(at, at + len);
  let end = 0;
  while (end < slice.length && slice[end] !== 0) end += 1;
  return Buffer.from(slice.subarray(0, end)).toString('utf8');
}

/** The regular files in a tar (ustar), with their sizes. Stops at the first zero block. */
export function tarEntries(tar: Uint8Array): TarEntry[] {
  const out: TarEntry[] = [];
  let at = 0;
  while (at + 512 <= tar.length) {
    const header = tar.subarray(at, at + 512);
    let zero = true;
    for (let i = 0; i < header.length; i += 1) if (header[i] !== 0) { zero = false; break; }
    if (zero) break;
    const name = text(header, 0, 100);
    const prefix = text(header, 345, 155);
    const size = Number.parseInt(text(header, 124, 12).trim(), 8);
    const type = header[156] ?? 0;
    if (!Number.isFinite(size) || size < 0) break;
    at += 512;
    // '0' is a regular file. A NUL type is the pre-ustar spelling of the same thing.
    const regular = type === 0 || type === 0x30;
    if (regular && name !== '') out.push({ name: prefix === '' ? name : `${prefix}/${name}`, size });
    at += Math.ceil(size / 512) * 512;
  }
  return out;
}
