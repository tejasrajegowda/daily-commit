// A stand-in for the phone's native vault plugin, behaving as the real one is specified to: one
// copy per mode, the own-code counter written before each try, the code and fingerprint copies
// deleted after the fifth wrong code. It keeps the master key in memory as plain text, so it lives
// in tests/ and can never ship.
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

export function fakePlugin() {
  const saved: Saved = { copies: new Map(), code: undefined, wrongTries: 0, invalid: new Set() };
  const log: string[] = [];
  let cancelNext = false;
  /** when set, the next open hands back this text instead of the stored copy */
  let lieNext: string | undefined;
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

  const make = (): VaultPlugin => ({
    async status() {
      log.push('status');
      return { modes: order.filter(m => saved.copies.has(m)) };
    },
    async enrol(mode, masterKey, newCode) {
      log.push(`enrol ${mode}`);
      if (mode === 'own-code') {
        if (newCode === undefined) throw new Error('own-code mode needs the code');
        saved.code = newCode;
        saved.wrongTries = 0;
      }
      saved.invalid.delete(mode);
      saved.copies.set(mode, masterKey);
    },
    async unwrap(mode) {
      log.push(`unwrap ${mode}`);
      if (cancelNext) {
        cancelNext = false;
        return { kind: 'Cancelled' };
      }
      return opened(mode);
    },
    async verifyCode(typed): Promise<CodeCheck> {
      log.push('verifyCode');
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
      return make();
    },
    /** a new fingerprint was enrolled on the phone: the fingerprint key stops working */
    invalidate: (mode: DeviceMode) => { saved.invalid.add(mode); },
    cancelNext: () => { cancelNext = true; },
    lieNext: (text: string) => { lieNext = text; },
  };
}
