// A raw `screencap` (no -p): a 12- or 16-byte header, then RGBA. Black means every pixel's RGB is 0.
// The header holds width and height as little-endian uint32 at bytes 0 and 4.

/** True when every pixel is black. Throws when the length is neither header size plus the pixels. */
export function isBlackRaw(raw: Uint8Array): boolean {
  if (raw.byteLength < 12) throw new Error('screencap is shorter than a header');
  const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  const w = view.getUint32(0, true);
  const h = view.getUint32(4, true);
  const pixels = w * h;
  if (!Number.isSafeInteger(pixels) || pixels <= 0) throw new Error('screencap size is not usable');
  const bytes = pixels * 4;
  const header = raw.byteLength - bytes;
  if (header !== 12 && header !== 16) throw new Error('screencap length does not match its header');
  for (let i = header; i + 3 < raw.byteLength; i += 4) {
    if ((raw[i] ?? 0) !== 0 || (raw[i + 1] ?? 0) !== 0 || (raw[i + 2] ?? 0) !== 0) return false;
  }
  return true;
}

/**
 * `black` when every pixel is. `bars` when the non-black rows are only the system bars,
 * split by a gap of at least four fifths of the height. `shown` when the app's own rows are not black.
 */
export function secureCapture(raw: Uint8Array): 'black' | 'bars' | 'shown' {
  if (isBlackRaw(raw)) return 'black';
  const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  const w = view.getUint32(0, true);
  const h = view.getUint32(4, true);
  const header = raw.byteLength - w * h * 4;
  const rows: number[] = [];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = header + (y * w + x) * 4;
      if ((raw[i] ?? 0) !== 0 || (raw[i + 1] ?? 0) !== 0 || (raw[i + 2] ?? 0) !== 0) {
        rows.push(y);
        break;
      }
    }
  }
  let gap = 0;
  for (let i = 1; i < rows.length; i++) gap = Math.max(gap, (rows[i] ?? 0) - (rows[i - 1] ?? 0));
  return gap >= h * 0.8 ? 'bars' : 'shown';
}
