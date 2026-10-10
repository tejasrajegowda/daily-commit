// A stand-in for the phone's native vault plugin, behaving as the real one is specified to: one
// copy per mode, the own-code counter written before each try, the code and fingerprint copies
// deleted after the fifth wrong code. A new copy waits beside the current one, in memory only,
// and replaces it only once it has opened back to the very key it was made from (as
// android/…/vault/VaultCore.java does); `restart()` drops a waiting copy. It keeps the master key
// in memory as plain text, so it lives in tests/ and can never ship.
//
// What the phone must keep across the app being closed is in `saved`: the copies, the code and the
// wrong-code count. `restart()` builds a new plugin from that alone, as the process starting again
// would; a count kept only in memory would give back all five guesses every time the app is closed.
import type { CodeCheck, DeviceMode, NativeOpen, VaultPlugin } from '../../src/vault/plugin.ts';

export const MAX_CODE_TRIES = 5;

interface Saved {
  readonly copies: Map<DeviceMode, string>;
  code: string | undefined;
  wrongTries: number;
  /** keys the phone stopped honouring (a new fingerprint was added) */
  readonly invalid: Set<DeviceMode>;
}

interface Waiting {
  readonly copy: string;
  readonly code: string | undefined;
}

export function fakePlugin() {
  const saved: Saved = { copies: new Map(), code: undefined, wrongTries: 0, invalid: new Set() };
  const log: string[] = [];
  let cancelNext = false;
  /** when set, the next open hands back this text instead of the stored copy */
  let lieNext: string | undefined;
  /** new copies not opened back yet; memory only, so restart() drops them */
  let waiting = new Map<DeviceMode, Waiting>();
  let missNext = false;
  const order: readonly DeviceMode[] = ['phone-lock', 'own-code', 'fingerprint'];

  /** Deletes a mode's copy (and its key); deleting the code's copy forgets the code too. */
  const drop = (mode: DeviceMode) => {
    saved.copies.delete(mode);
    if (mode === 'own-code') saved.code = undefined;
  };

  const opened = (mode: DeviceMode): NativeOpen => {
    const copy = saved.copies.get(mode);
    if (copy === undefined || saved.invalid.has(mode)) return { kind: 'Missing' };
    if (lieNext !== undefined) {
      const lie = lieNext;
      lieNext = undefined;
      return { kind: 'Key', masterKey: lie };
    }
    return { kind: 'Key', masterKey: copy };
  };

  /** Opens a waiting copy: only a copy that opened back replaces the current one. */
  const openWaiting = (mode: DeviceMode, w: Waiting): NativeOpen => {
    waiting.delete(mode);
    if (missNext) {
      missNext = false;
      return { kind: 'Missing' };
    }
    if (lieNext !== undefined) {                          // the phone handed back something else: nothing is kept
      const lie = lieNext;
      lieNext = undefined;
      return { kind: 'Key', masterKey: lie };
    }
    saved.copies.set(mode, w.copy);
    saved.invalid.delete(mode);
    if (mode === 'own-code') {
      saved.code = w.code;
      saved.wrongTries = 0;
    }
    return { kind: 'Key', masterKey: w.copy };
  };

  const make = (): VaultPlugin => ({
    async status() {
      log.push('status');
      return { modes: order.filter(m => saved.copies.has(m)) };
    },
    async enrol(mode, masterKey, newCode) {
      log.push(`enrol ${mode}`);
      if (mode === 'own-code' && newCode === undefined) throw new Error('own-code mode needs the code');
      waiting.set(mode, { copy: masterKey, code: mode === 'own-code' ? newCode : undefined });
    },
    async unwrap(mode) {
      log.push(`unwrap ${mode}`);
      if (cancelNext) {
        cancelNext = false;
        waiting.delete(mode);
        return { kind: 'Cancelled' };
      }
      const w = waiting.get(mode);
      if (w) return openWaiting(mode, w);
      if (missNext) { missNext = false; return { kind: 'Missing' }; }
      return opened(mode);
    },
    async verifyCode(typed): Promise<CodeCheck> {
      log.push('verifyCode');
      const w = waiting.get('own-code');
      if (w) {
        if (typed !== w.code) {                             // the new code never took; the old one still opens (not counted)
          waiting.delete('own-code');
          return { kind: 'Missing' };
        }
        const back = openWaiting('own-code', w);
        return back.kind === 'Cancelled' ? { kind: 'Missing' } : back;
      }
      if (!saved.copies.has('own-code')) return { kind: 'Missing' };
      saved.wrongTries += 1;                 // saved before the code is compared
      if (typed !== saved.code) {
        const triesLeft = MAX_CODE_TRIES - saved.wrongTries;
        if (triesLeft <= 0) {
          drop('own-code');
          drop('fingerprint');
        }
        return { kind: 'WrongCode', triesLeft: Math.max(triesLeft, 0) };
      }
      saved.wrongTries = 0;
      const back = opened('own-code');
      return back.kind === 'Key' ? back : { kind: 'Missing' };
    },
    async remove(mode) {
      log.push(`remove ${mode}`);
      waiting.delete(mode);
      drop(mode);
    },
  });

  return {
    plugin: make(),
    log,
    copies: saved.copies,
    /** the app's process started again: a new plugin with only what the phone saved */
    restart: (): VaultPlugin => {
      cancelNext = false;
      lieNext = undefined;
      waiting = new Map();
      missNext = false;
      return make();
    },
    /** a new fingerprint was enrolled on the phone: the fingerprint key stops working */
    invalidate: (mode: DeviceMode) => { saved.invalid.add(mode); },
    cancelNext: () => { cancelNext = true; },
    lieNext: (text: string) => { lieNext = text; },
    /** the next copy the phone opens comes back Missing, as a new copy that didn't open back does */
    missNext: () => { missNext = true; },
    /** the modes with a new copy waiting to be opened back */
    waiting: () => [...waiting.keys()],
  };
}
