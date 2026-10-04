import { test } from 'node:test';
import assert from 'node:assert/strict';
import { minuteClock } from '../../src/app/clock.ts';

function scheduler() {
  const queue: { run: () => void; ms: number; cancelled: boolean }[] = [];
  const schedule = (run: () => void, ms: number) => {
    const job = { run, ms, cancelled: false };
    queue.push(job);
    return job;
  };
  const cancel = (job: unknown) => { (job as { cancelled: boolean }).cancelled = true; };
  return { queue, schedule, cancel };
}

test('minute() is now floored to the minute', () => {
  const s = scheduler();
  const clock = minuteClock(() => Date.UTC(2026, 0, 5, 9, 0, 42, 500), s.schedule, s.cancel);
  assert.equal(clock.minute(), Date.UTC(2026, 0, 5, 9, 0));
  clock.stop();
});

test('the first tick waits for the next minute, then the one after; each tick tells the listeners', () => {
  let now = Date.UTC(2026, 0, 5, 9, 0, 42, 500);
  const s = scheduler();
  const clock = minuteClock(() => now, s.schedule, s.cancel);
  let heard = 0;
  clock.subscribe(() => { heard++; });
  assert.equal(s.queue[0]?.ms, 17_500);
  now = Date.UTC(2026, 0, 5, 9, 1, 0, 3);
  s.queue[0]?.run();
  assert.equal(heard, 1);
  assert.equal(clock.minute(), Date.UTC(2026, 0, 5, 9, 1));
  assert.equal(s.queue[1]?.ms, 59_997);
  clock.stop();
});

test('a clock that stands still (the harness) still ticks without moving the minute', () => {
  const s = scheduler();
  const clock = minuteClock(() => Date.UTC(2026, 0, 5, 9, 0), s.schedule, s.cancel);
  assert.equal(s.queue[0]?.ms, 60_000);
  s.queue[0]?.run();
  assert.equal(clock.minute(), Date.UTC(2026, 0, 5, 9, 0));
  clock.stop();
});

test('stop() cancels the next tick', () => {
  const s = scheduler();
  const clock = minuteClock(() => 0, s.schedule, s.cancel);
  clock.stop();
  assert.equal(s.queue[0]?.cancelled, true);
});
