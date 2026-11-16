// The tablet's stand-in for the owner, in the Tests user only (D-36). It does what the dry run's stand-in does on
// the emulator: the owner's part at Android's file picker, and the yes/no answers measured on the device. The
// Tests user is ours to act on, so it may read the whole screen there and act outside the app; every command
// still goes through the tablet lane, which runs it only while the Tests user is the one on screen.
// What it can't do (a fingerprint, the phone's PIN, typing on the real keyboard) stays "not done".
import { runAdb } from '../adbGate.ts';
import { driver, nodesOf, type DeviceIo } from '../drive.ts';
import { hierarchyOf, tabletAdb } from './guard.ts';
import type { StandIn } from './p.ts';
import { forTestsUser, Refused, TESTS_IME_READ, TESTS_SCREEN_DUMP } from './shellAllow.ts';
import { makeStandIn } from './standin.ts';

export function tabletStandIn(serial: string): StandIn {
  if (serial.startsWith('emulator-')) throw new Refused('an emulator is not the tablet');
  const io: DeviceIo = {
    shell: command => tabletAdb(['-s', serial, 'shell', forTestsUser(command)]),
    execOut: args => runAdb('tablet', ['-s', serial, 'exec-out', ...args], { timeoutMs: 60_000 }).stdout,
    dump() {
      const xml = hierarchyOf(tabletAdb(['-s', serial, 'shell', TESTS_SCREEN_DUMP]).out);
      return xml === '' ? undefined : { xml: '', nodes: nodesOf(xml) };
    },
    finger() {
      throw new Refused('the fingerprint is the owner\'s');
    },
  };
  const phone = driver(io);
  // the window list would also name the owner's windows, so the screenshot itself is the answer there
  return makeStandIn(phone, { secure: () => undefined, ime: () => phone.shell(TESTS_IME_READ).out, screen: () => phone.dump() });
}
