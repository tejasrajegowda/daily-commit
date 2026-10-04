// One clock for the screens: the record's own now, floored to the minute, with a tick at each new
// minute so the sun, the morning-or-evening switch and the day line move. It only draws; the lock
// never runs on it.

export interface MinuteClock {
  /** the record's now, floored to the minute (ms) */
  readonly minute: () => number;
  subscribe(listener: () => void): () => void;
  stop(): void;
}

const MINUTE = 60_000;

export function minuteClock(
  now: () => number,
  schedule: (run: () => void, ms: number) => unknown = (run, ms) => setTimeout(run, ms),
  cancel: (job: unknown) => void = job => clearTimeout(job as ReturnType<typeof setTimeout>),
): MinuteClock {
  const listeners = new Set<() => void>();
  let job: unknown;
  let stopped = false;

  const next = () => {
    if (stopped) return;
    job = schedule(tick, MINUTE - (now() % MINUTE));
  };
  function tick() {
    for (const listener of [...listeners]) {
      try {
        listener();
      } catch {
        // a screen that fails to draw never stops the clock
      }
    }
    next();
  }
  next();

  return {
    minute: () => now() - (now() % MINUTE),
    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    stop() {
      stopped = true;
      cancel(job);
    },
  };
}
