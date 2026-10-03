// Where the lock's random bytes come from. It is handed in, like the record's clock, so tests can
// pin a golden value; the app always uses the system's.

export type Random = (n: number) => Uint8Array<ArrayBuffer>;

export const systemRandom: Random = n => crypto.getRandomValues(new Uint8Array(n));
