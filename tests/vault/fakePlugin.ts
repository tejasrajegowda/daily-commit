// A stand-in for the phone's native vault plugin, behaving as the real one is specified to: one
// copy per mode, the own-code counter written before each try, the code and fingerprint copies
// deleted after the fifth wrong code. It keeps the master key in memory as plain text, so it lives
// in tests/ and can never ship.
import type { CodeCheck, DeviceMode, NativeOpen, VaultPlugin } from '../../src/vault/plugin.ts';

export const MAX_CODE_TRIES = 5;

export function fakePlugin() {
  const copies = new Map<DeviceMode, string>();
  let code: string | undefined;
  let wrongTries = 0;
  const log: string[] = [];
  const invalid = new Set<DeviceMode>();
  let cancelNext = false;
  /** when set, the next open hands back this text instead of the stored copy */
  let lieNext: string | undefined;
  const order: readonly DeviceMode[] = ['phone-lock', 'own-code', 'fingerprint'];

  const opened = (mode: DeviceMode): NativeOpen => {
    const copy = copies.get(mode);
    if (copy === undefined || invalid.has(mode)) return { kind: 'Missing' };
    if (lieNext !== undefined) {
      const lie = lieNext;
      lieNext = undefined;
      return { kind: 'Key', masterKey: lie };
    }
    return { kind: 'Key', masterKey: copy };
  };

  const plugin: VaultPlugin = {
    async status() {
      log.push('status');
      return { modes: order.filter(m => copies.has(m)) };
    },
    async enrol(mode, masterKey, newCode) {
      log.push(`enrol ${mode}`);
      if (mode === 'own-code') {
        if (newCode === undefined) throw new Error('own-code mode needs the code');
        code = newCode;
        wrongTries = 0;
      }
      invalid.delete(mode);
      copies.set(mode, masterKey);
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
      if (!copies.has('own-code')) return { kind: 'Missing' };
      wrongTries += 1;                       // written before the code is compared
      if (typed !== code) {
        const triesLeft = MAX_CODE_TRIES - wrongTries;
        if (triesLeft <= 0) {
          copies.delete('own-code');
          copies.delete('fingerprint');
          code = undefined;
        }
        return { kind: 'WrongCode', triesLeft: Math.max(triesLeft, 0) };
      }
      wrongTries = 0;
      const back = opened('own-code');
      return back.kind === 'Key' ? back : { kind: 'Missing' };
    },
    async remove(mode) {
      log.push(`remove ${mode}`);
      copies.delete(mode);
      if (mode === 'own-code') code = undefined;
    },
  };
  return {
    plugin,
    log,
    copies,
    /** a new fingerprint was enrolled on the phone: the fingerprint key stops working */
    invalidate: (mode: DeviceMode) => { invalid.add(mode); },
    cancelNext: () => { cancelNext = true; },
    lieNext: (text: string) => { lieNext = text; },
  };
}
