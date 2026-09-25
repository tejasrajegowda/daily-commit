// The promises the numbers make, checked against thousands of invented histories each run.
// (Invariant 4 — the morning screen shows no history — is a screen test and lives with the screens.)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fc from 'fast-check';
import type { Habit, HabitKind, Observation } from '../../src/rules/types.ts';
import { addDays, datesFrom } from '../../src/rules/dates.ts';
import { indexObservations, stateOf } from '../../src/rules/state.ts';
import { doneAndAsked, habitNumbers } from '../../src/rules/stats.ts';
import { focusDone, heatLevel } from '../../src/rules/heat.ts';
import { goesWellTogether, PATTERNS_FROM_DAY } from '../../src/rules/patterns.ts';
import { cueSchedule, type Cue } from '../../src/rules/cues.ts';
import { band, bandWords, countWord, momentum } from '../../src/rules/words.ts';
import { dayNumber } from '../../src/rules/journey.ts';
import { arbCell, arbTracked, habit, history, START, type Cell } from './fixtures.ts';

const RUNS = { numRuns: 1000 };
const DAYS = 45;
const lastDay = addDays(START, DAYS - 1);
const arbToday = fc.integer({ min: 0, max: DAYS - 1 }).map(i => addDays(START, i));

/** Several habits, each with its own invented history. */
const arbWorld = fc.integer({ min: 1, max: 4 }).chain(n =>
  fc.tuple(...Array.from({ length: n }, (_, i) => arbTracked(`h${i}`, DAYS))));

function indexOf(world: readonly { habit: Habit; cells: readonly Cell[] }[]) {
  return indexObservations(world.flatMap(w => history(w.habit.id, w.cells)));
}

const LIFETIME = ['did', 'minutes', 'longestRun', 'cameBack', 'gaps'] as const;

test('1 · adding a habit never lowers any number', () => {
  fc.assert(fc.property(arbWorld, arbTracked('extra', DAYS), arbToday, (world, extra, today) => {
    const before = indexOf(world), after = indexOf([...world, extra]);
    const habits = world.map(w => w.habit);
    for (const h of habits) {
      assert.deepEqual(habitNumbers(h, after, START, today), habitNumbers(h, before, START, today));
      assert.deepEqual(doneAndAsked(h, after, START, today), doneAndAsked(h, before, START, today));
    }
    for (const date of datesFrom(START, today)) {
      const a = focusDone([...habits, extra.habit], after, date), b = focusDone(habits, before, date);
      assert.ok(a >= b);
      assert.ok(heatLevel(a) >= heatLevel(b));
    }
  }), RUNS);
});

/** A "not today" answer: the three-way "not", a zero for minutes or counts, or "not" for anything else. */
function isNotToday(o: Observation, kind: HabitKind): boolean {
  if (o.planned) return false;
  if (o.value === undefined || o.value === 'not') return true;
  return (kind === 'min' || kind === 'count') && o.value === 0;
}

test('2 · a day marked "not today" and a day never answered give identical results', () => {
  fc.assert(fc.property(arbWorld, arbToday, (world, today) => {
    const habits = world.map(w => w.habit);
    const all = world.flatMap(w => history(w.habit.id, w.cells));
    const kindOf = new Map(habits.map(h => [h.id, h.kind]));
    const answered = indexObservations(all);
    const unanswered = indexObservations(all.filter(o => !isNotToday(o, kindOf.get(o.habitId)!)));
    const pairs = habits.flatMap(a => habits.map(b => ({ when: a.id, then: b.id })));
    const cues: Cue[] = habits.map(h => ({ id: `c-${h.id}`, habitId: h.id, kind: 'cue', text: 'Cue', times: { at: [600] }, enabled: true, createdOn: START }));
    const settings = { cuesOn: true, wake: 360, lightsOut: 1380 };
    for (const h of habits) {
      assert.deepEqual(habitNumbers(h, answered, START, today), habitNumbers(h, unanswered, START, today));
      assert.deepEqual(doneAndAsked(h, answered, START, today), doneAndAsked(h, unanswered, START, today));
    }
    for (const date of datesFrom(START, today)) {
      for (const h of habits) assert.equal(stateOf(h, answered.get(`${h.id}|${date}`), date), stateOf(h, unanswered.get(`${h.id}|${date}`), date));
      assert.equal(focusDone(habits, answered, date), focusDone(habits, unanswered, date));
      assert.deepEqual(cueSchedule(date, cues, habits, answered, settings), cueSchedule(date, cues, habits, unanswered, settings));
    }
    assert.deepEqual(goesWellTogether(habits, answered, pairs, START, today, 90), goesWellTogether(habits, unanswered, pairs, START, today, 90));
  }), RUNS);
});

test('3 · every lifetime number is non-decreasing as days are added', () => {
  fc.assert(fc.property(arbTracked('h', DAYS), (t) => {
    const idx = indexObservations(history('h', t.cells));
    let prev = habitNumbers(t.habit, idx, START, START);
    let prevDay = dayNumber(START, START);
    for (const today of datesFrom(addDays(START, 1), lastDay)) {
      const now = habitNumbers(t.habit, idx, START, today);
      for (const k of LIFETIME) assert.ok(now[k] >= prev[k], `${k} went down on ${today}`);
      const day = dayNumber(START, today);
      assert.ok(day > prevDay);
      prev = now; prevDay = day;
    }
  }), RUNS);
});

test('5 · no percentage is ever produced', () => {
  fc.assert(fc.property(fc.nat(400), fc.nat(400), (a, b) => {
    const said = [bandWords(band(a, b), 'week'), bandWords(band(a, b), 'month'), momentum(a, b), countWord(a)];
    for (const s of said) assert.ok(!s.includes('%') && !/per ?cent/i.test(s), s);
  }), RUNS);
});

test('6 · mood is never joined to a habit before day 60', () => {
  const mood = habit({ id: 'mood', kind: 'mood', tierHistory: [{ tier: 'focus', from: START }] });
  fc.assert(fc.property(
    arbWorld, fc.array(arbCell('mood'), { minLength: DAYS, maxLength: DAYS }), fc.integer({ min: 1, max: PATTERNS_FROM_DAY - 1 }),
    (world, moodCells, journeyDay) => {
      const habits = [...world.map(w => w.habit), mood];
      const idx = indexObservations([...world.flatMap(w => history(w.habit.id, w.cells)), ...history('mood', moodCells)]);
      const pairs = habits.flatMap(a => habits.map(b => ({ when: a.id, then: b.id })));
      assert.deepEqual(goesWellTogether(habits, idx, pairs, START, lastDay, journeyDay), []);
      for (const found of goesWellTogether(habits, idx, pairs, START, lastDay, 90)) assert.notEqual(found.when, 'mood');
      // and mood never brightens the months view, even if it were placed in Focus
      for (const date of datesFrom(START, lastDay)) assert.equal(focusDone(habits, idx, date), focusDone(habits.slice(0, -1), idx, date));
    }), RUNS);
});

const walkDaily = habit({ id: 'w', kind: 'tri' });

test('7 · a run survives any single quiet day', () => {
  fc.assert(fc.property(fc.integer({ min: 3, max: DAYS }), fc.nat(), (n, k) => {
    const quiet = k % (n - 1);                                 // any day but today
    const cells: Cell[] = Array.from({ length: n }, (_, i) => (i === quiet ? null : { value: 'did' }));
    const r = habitNumbers(walkDaily, indexObservations(history('w', cells)), START, addDays(START, n - 1));
    assert.equal(r.currentRun, n - 1);
    assert.equal(r.longestRun, n - 1);
  }), RUNS);
});

test('7 · with no two quiet days in a row, the run is every done day', () => {
  const token = fc.constantFrom<'did' | 'partly' | 'quiet' | 'rest'>('did', 'partly', 'quiet', 'rest');
  fc.assert(fc.property(fc.array(token, { minLength: 1, maxLength: DAYS }), (tokens) => {
    let last: string | undefined;
    const cells: Cell[] = tokens.map(t => {
      if (t === 'rest') return { planned: 'rest' };
      const use = t === 'quiet' && last === 'quiet' ? 'did' : t;
      last = use;
      return use === 'quiet' ? null : { value: use };
    });
    const r = habitNumbers(walkDaily, indexObservations(history('w', cells)), START, addDays(START, cells.length - 1));
    assert.equal(r.currentRun, r.did);
  }), RUNS);
});
