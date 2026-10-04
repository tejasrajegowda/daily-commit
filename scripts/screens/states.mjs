// The harness states the screenshots and the design gate visit: [id, hash]. Each task adds its own.
export const STATES = [
  ['lock', 's=lock&t=06:05'],
  ['lockown', 's=lock&v=own&t=06:05'],
  ['lockpass', 's=lock&v=pass&t=06:05'],
  ['lockfive', 's=lock&v=five&t=06:05'],
  ['locknewfinger', 's=lock&v=newfinger&t=06:05'],
  ['morning', 's=today&t=06:48'],
  ['practice', 's=today&t=08:40'],
  ['evening', 's=today&t=21:30'],
  ['closed', 's=today&t=22:58&v=closed'],
  ['saturday', 's=today&t=10:30&age=20'],
  ['first1', 's=first&t=13:00'],
  ['found', 's=first&v=found&t=13:00'],
  ['restore', 's=restore&t=13:00'],
  ['restore-replace', 's=restore&v=replace&t=13:00'],
];

/** The two sizes every screen is checked at: a small phone and a laptop. */
export const SIZES = [
  { name: 'phone', width: 360, height: 780, dsf: 2, touch: true },
  { name: 'laptop', width: 1440, height: 900, dsf: 1, touch: false },
];
