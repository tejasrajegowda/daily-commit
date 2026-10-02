/** A uuid v7: 48 bits of milliseconds, then random bits, so ids sort by when they were made. */
export function uuidv7(nowMs: number, random: Uint8Array = crypto.getRandomValues(new Uint8Array(16))): string {
  const b = random.slice(0, 16);
  let t = nowMs;
  for (let i = 5; i >= 0; i--) {
    b[i] = t % 256;
    t = Math.floor(t / 256);
  }
  b[6] = ((b[6] ?? 0) & 0x0f) | 0x70;   // version 7
  b[8] = ((b[8] ?? 0) & 0x3f) | 0x80;   // the RFC 9562 variant
  const h = Array.from(b, x => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}
