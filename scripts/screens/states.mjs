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
  ['look', 's=look&t=12:30'],
  ['look1', 's=look&t=12:30&age=1'],
  ['look60', 's=look&t=12:30&age=60'],
  ['look120', 's=look&t=12:30&age=120'],
  ['habit', 's=habit&v=h-wake&t=12:30&age=40'],
  ['week', 's=week&t=10:30'],
  ['month', 's=month&t=12:30&age=60&v=steady'],
  ['diary', 's=diary&t=22:20'],
  ['notyet', 's=notyet&t=22:30'],
  ['plan', 's=plan&t=13:00'],
  ['settings', 's=settings&t=13:00'],
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
