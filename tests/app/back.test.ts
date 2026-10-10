import { test } from 'node:test';
import assert from 'node:assert/strict';
import { backLayers, backStep } from '../../src/app/back.ts';

const at = (screen: Parameters<typeof backStep>[0]['nav']['screen'], variant = '') => ({ screen, variant });

test('Back closes what is open on top first: a sheet, or the restore flow', () => {
  assert.deepEqual(backStep({ layers: 1, recordOpen: true, nav: at('plan') }), { kind: 'layer' });
  assert.deepEqual(backStep({ layers: 1, recordOpen: false, nav: at('today') }), { kind: 'layer' });
});

test('then the screen\'s own way back, then Today', () => {
  assert.deepEqual(backStep({ layers: 0, recordOpen: true, nav: at('secret', 'pass') }), { kind: 'go', screen: 'settings', variant: 'privacy' });
  assert.deepEqual(backStep({ layers: 0, recordOpen: true, nav: at('support') }), { kind: 'go', screen: 'settings', variant: '' });
  for (const s of ['look', 'habit', 'week', 'month', 'diary', 'notyet', 'plan', 'settings'] as const) {
    assert.deepEqual(backStep({ layers: 0, recordOpen: true, nav: at(s) }), { kind: 'go', screen: 'today', variant: '' }, s);
  }
});

test('on Today, on the lock screen and in first run, Back leaves the app, which locks it', () => {
  assert.deepEqual(backStep({ layers: 0, recordOpen: true, nav: at('today') }), { kind: 'leave' });
  assert.deepEqual(backStep({ layers: 0, recordOpen: false, nav: at('look') }), { kind: 'leave' });
});

test('layers close last first, and one taken off is gone', () => {
  const l = backLayers();
  const closed: string[] = [];
  const offA = l.push(() => closed.push('a'));
  const offB = l.push(() => closed.push('b'));
  l.closeTop();
  offB();
  l.closeTop();
  offA();
  assert.deepEqual(closed, ['b', 'a']);
  assert.equal(l.size(), 0);
  l.closeTop();                                                // nothing open: nothing happens
});
