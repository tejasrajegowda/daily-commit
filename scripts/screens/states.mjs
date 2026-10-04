// The harness states the screenshots and the design gate visit: [id, hash]. Each task adds its own.
export const STATES = [
  ['lock', 's=lock&t=06:05'],
  ['lockown', 's=lock&v=own&t=06:05'],
  ['lockpass', 's=lock&v=pass&t=06:05'],
  ['lockfive', 's=lock&v=five&t=06:05'],
  ['locknewfinger', 's=lock&v=newfinger&t=06:05'],
  ['today-frame', 's=today&t=13:00'],
];

/** The two sizes every screen is checked at: a small phone and a laptop. */
export const SIZES = [
  { name: 'phone', width: 360, height: 780, dsf: 2, touch: true },
  { name: 'laptop', width: 1440, height: 900, dsf: 1, touch: false },
];
