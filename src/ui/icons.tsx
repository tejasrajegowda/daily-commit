import type { ReactNode } from 'react';

// One family: a 24px grid, 1.6 stroke, round ends (the stroke is set in app.css on .i). Fills only
// where a fill means "recorded".

const svg = (body: ReactNode, cls = 'i') => (
  <svg className={cls} viewBox="0 0 24 24" aria-hidden="true">{body}</svg>
);

const dim = { fill: 'currentColor', fillOpacity: 0.55 } as const;

export const I = {
  today: () => svg(<><path d="M2.8 17.5h18.4" /><path d="M6.3 17.5a5.7 5.7 0 0 1 11.4 0" /><path d="M12 6v2.3M6.4 8.4l1.5 1.5M17.6 8.4l-1.5 1.5" /></>),
  look: () => svg(<>
    <rect x="3.4" y="6" width="4.6" height="4.6" rx="1.3" /><rect x="9.7" y="6" width="4.6" height="4.6" rx="1.3" {...dim} />
    <rect x="16" y="6" width="4.6" height="4.6" rx="1.3" {...dim} /><rect x="3.4" y="13.4" width="4.6" height="4.6" rx="1.3" {...dim} />
    <rect x="9.7" y="13.4" width="4.6" height="4.6" rx="1.3" /><rect x="16" y="13.4" width="4.6" height="4.6" rx="1.3" {...dim} />
  </>),
  diary: () => svg(<><path d="M4.5 19.2l1.1-4.4L15.4 5a2.1 2.1 0 0 1 3 0l.5.5a2.1 2.1 0 0 1 0 3L9.1 18.3z" /><path d="M13.6 6.8l3.5 3.5" /><path d="M4.5 21h8" /></>),
  plan: () => svg(<><rect x="3.5" y="4.4" width="17" height="4.2" rx="2.1" /><rect x="3.5" y="10" width="17" height="4.2" rx="2.1" /><rect x="3.5" y="15.6" width="10.5" height="4.2" rx="2.1" /></>),
  gear: () => svg(<><path d="M18.67 9.56 L20.99 9.61 L20.99 14.39 L18.67 14.44 L18.44 14.99 L20.05 16.66 L16.66 20.05 L14.99 18.44 L14.44 18.67 L14.39 20.99 L9.61 20.99 L9.56 18.67 L9.01 18.44 L7.34 20.05 L3.95 16.66 L5.56 14.99 L5.33 14.44 L3.01 14.39 L3.01 9.61 L5.33 9.56 L5.56 9.01 L3.95 7.34 L7.34 3.95 L9.01 5.56 L9.56 5.33 L9.61 3.01 L14.39 3.01 L14.44 5.33 L14.99 5.56 L16.66 3.95 L20.05 7.34 L18.44 9.01Z" /><circle cx="12" cy="12" r="3" /></>),
  lock: () => svg(<><rect x="5" y="10.5" width="14" height="9.5" rx="2.6" /><path d="M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5" /></>),
  brand: () => svg(<><path d="M2.8 17h18.4" /><path d="M6.4 17a5.6 5.6 0 0 1 11.2 0z" fill="currentColor" stroke="none" /></>),
  finger: () => svg(<>
    <path d="M12 11.6v3.2c0 2.1.6 3.8 1.7 5.3" /><path d="M8.7 20.3c-1-1.7-1.5-3.5-1.5-5.5v-2.9a4.8 4.8 0 0 1 9.6 0v2.5" />
    <path d="M5.3 17.7c-.5-1.2-.8-2.5-.8-3.9v-1.9a7.5 7.5 0 0 1 12.8-5.3" /><path d="M19.2 9.3c.2.8.3 1.7.3 2.6v2.3" /><path d="M16.7 18.6c.2-.9.3-1.8.3-2.8" />
  </>),
  back: () => svg(<path d="M14.5 5.5 8 12l6.5 6.5" />),
  chev: () => svg(<path d="m9.5 6 6 6-6 6" />),
  plus: () => svg(<path d="M12 5v14M5 12h14" />),
  search: () => svg(<><circle cx="11" cy="11" r="6" /><path d="m20 20-4.3-4.3" /></>),
  x: () => svg(<path d="M6 6l12 12M18 6 6 18" />),
  del: () => svg(<><path d="M9 6h10a1.5 1.5 0 0 1 1.5 1.5v9A1.5 1.5 0 0 1 19 18H9l-5.5-6z" /><path d="m12 9.5 5 5M17 9.5l-5 5" /></>),
};
