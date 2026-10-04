// The harness states the screenshots and the design gate visit: [id, hash]. Each task adds its own.
export const STATES = [
  ['blank', 's=today'],
];

/** The two sizes every screen is checked at: a small phone and a laptop. */
export const SIZES = [
  { name: 'phone', width: 360, height: 780, dsf: 2, touch: true },
  { name: 'laptop', width: 1440, height: 900, dsf: 1, touch: false },
];
