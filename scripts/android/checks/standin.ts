// The dry run's stand-in for the owner, on the dc- test emulator only. It does the owner's part at Android's
// file picker, and answers the owner's yes/no questions from what the emulator can measure, each answer
// saying how it was measured. It reaches the emulator only through adbOnTestPhone, which refuses any serial
// but emulator-5556, so it can never reach the phone; the sitting makes one only with --dry-run.
// What it can't measure (a fingerprint, the phone's PIN, a blink shorter than a screen read) stays the owner's.
import { Buffer } from 'node:buffer';
import { windowIsSecure } from '../smoke.ts';
import { adbOnTestPhone, emu, find, pause, type Emu, type UiNode } from '../drive.ts';
import { focusDiaryPage, launch, pastLock, pickInPicker } from './a.ts';
import { frontOf } from './guard.ts';
import { lockOn, type Act, type ItemKey, type StandIn } from './p.ts';
import { secureCapture } from './screen.ts';

const APP = 'app.dailycommit';
const NO_PERSONALIZED_LEARNING = 0x1000000;            // EditorInfo.IME_FLAG_NO_PERSONALIZED_LEARNING

/** The record showing on the first read after coming back is a blink ('yes'); the lock first is none ('no'). */
export function blinkAnswer(reads: readonly (readonly UiNode[])[]): 'yes' | 'no' | undefined {
  for (const nodes of reads) {
    if (lockOn(nodes)) return 'no';
    if (pastLock(nodes)) return 'yes';
  }
  return undefined;
}

/** From `dumpsys input_method`: whether the focused field tells the keyboard not to learn. Undefined with no field. */
export function noLearning(dump: string): boolean | undefined {
  const at = dump.search(/mCurEditorInfo|mCurAttribute|mInputEditorInfo/);
  const from = at >= 0 ? dump.slice(at) : dump;
  const block = from.split(/\r?\n/).slice(0, 4).join('\n');
  const m = /imeOptions=0x([0-9a-f]+)/i.exec(at >= 0 ? block : from);
  if (m?.[1] === undefined) return undefined;
  return (Number.parseInt(m[1], 16) & NO_PERSONALIZED_LEARNING) !== 0;
}

/**
 * From a raw screencap of the Recents overview: whether the middle of the centred card is one plain colour (the
 * app-theme picture Android shows for a task whose own picture is off). Undefined when the capture isn't usable.
 */
export function plainCard(raw: Uint8Array): boolean | undefined {
  if (raw.byteLength < 12) return undefined;
  const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  const w = view.getUint32(0, true);
  const h = view.getUint32(4, true);
  const header = raw.byteLength - w * h * 4;
  if (w === 0 || h === 0 || (header !== 12 && header !== 16)) return undefined;
  const counts = new Map<number, number>();
  let all = 0;
  for (let y = Math.floor(h * 0.35); y < Math.floor(h * 0.65); y++) {
    for (let x = Math.floor(w * 0.3); x < Math.floor(w * 0.7); x++) {
      const i = header + (y * w + x) * 4;
      // Four bits a channel, so JPEG noise in a plain picture still counts as one colour.
      const key = (((raw[i] ?? 0) >> 4) << 8) | (((raw[i + 1] ?? 0) >> 4) << 4) | ((raw[i + 2] ?? 0) >> 4);
      counts.set(key, (counts.get(key) ?? 0) + 1);
      all++;
    }
  }
  if (all === 0) return undefined;
  return Math.max(...counts.values()) / all >= 0.97;
}

/** A raw screencap, or why there is none (the start of what screencap said instead). */
function capture(phone: Emu): { raw: Uint8Array } | { none: string } {
  const raw = phone.execOut(['screencap']);
  if (raw.byteLength >= 12) return { raw };
  const said = Buffer.from(raw).toString('utf8').replace(/\s+/g, ' ').trim().slice(0, 80);
  return { none: said === '' ? 'nothing' : said };
}

function size(phone: Emu): readonly [number, number] {
  const out = phone.shell('wm size').out;
  const m = /Override size: (\d+)x(\d+)/.exec(out) ?? /Physical size: (\d+)x(\d+)/.exec(out);
  return [Number(m?.[1] ?? 1080), Number(m?.[2] ?? 2400)];
}

function ours(phone: Emu): UiNode[] {
  return phone.dump().filter(n => n.pkg === APP);
}

/** Screen reads, as fast as they come, until one is the lock or the record. */
function firstScreen(phone: Emu, ms: number): 'yes' | 'no' | undefined {
  const reads: UiNode[][] = [];
  const until = Date.now() + ms;
  while (Date.now() < until) {
    reads.push(ours(phone));
    const got = blinkAnswer(reads);
    if (got !== undefined) return got;
    pause(250);
  }
  return undefined;
}

function blink(value: 'yes' | 'no' | undefined, how: string): { value: 'yes' | 'no'; how: string } | undefined {
  if (value === undefined) return undefined;
  return { value, how: `${how}; the first screen read after it showed ${value === 'no' ? 'the lock' : 'the record'} (a blink shorter than a read is the owner's eyes)` };
}

function inFront(phone: Emu, ms: number): boolean {
  const until = Date.now() + ms;
  for (;;) {
    if (frontOf(phone.shell('dumpsys window | grep mCurrentFocus').out) === 'app') return true;
    if (Date.now() >= until) return false;
    pause(400);
  }
}

export function dryRunStandIn(): StandIn {
  const phone = emu();
  let learning: boolean | undefined;
  const fieldLearning = (): boolean | undefined => {
    if (learning !== undefined) return learning;
    phone.tap('Diary', 20_000);
    focusDiaryPage(phone);
    pause(1_000);
    learning = noLearning(phone.shell('dumpsys input_method').out);
    phone.key('KEYCODE_BACK');                           // the keyboard down
    return learning;
  };
  const answers: Partial<Record<ItemKey, () => { value: 'yes' | 'no'; how: string } | undefined>> = {
    'P6.screenshot': () => {
      const secure = windowIsSecure(adbOnTestPhone(['shell', 'dumpsys window windows']).out);
      const shot = capture(phone);
      if ('none' in shot) {
        return { value: secure ? 'yes' : 'no', how: `the window is ${secure ? '' : 'not '}secure and screencap gave no picture (it said: ${shot.none})` };
      }
      const captured = secureCapture(shot.raw);
      return {
        value: secure && captured !== 'shown' ? 'yes' : 'no',
        how: `the window is ${secure ? '' : 'not '}secure and a screencap shows ${captured === 'shown' ? "the app's rows" : captured === 'bars' ? 'only the system bars' : 'black'}`,
      };
    },
    'P6.recents': () => {
      // A file in Android's snapshot store is not the answer: for a task whose picture is off, Android still keeps a
      // plain one in the app's theme colour. What the owner sees is the card, so the card is what is measured.
      phone.key('KEYCODE_HOME');
      pause(1_200);
      phone.key('KEYCODE_APP_SWITCH');
      pause(2_000);
      const shot = capture(phone);
      phone.key('KEYCODE_HOME');
      if ('none' in shot) return undefined;
      const plain = plainCard(shot.raw);
      if (plain === undefined) return undefined;
      return { value: plain ? 'yes' : 'no', how: `a screencap of Recents shows the app's card ${plain ? 'as one plain colour' : 'with more than one colour in its middle'}` };
    },
    'P6.blinkIcon': () => {
      phone.key('KEYCODE_HOME');
      pause(3_000);
      launch(phone, false);
      return blink(firstScreen(phone, 15_000), 'Home, 3 s, then started the way its icon starts it');
    },
    'P6.blinkRecents': () => {
      phone.key('KEYCODE_HOME');
      pause(1_200);
      phone.key('KEYCODE_APP_SWITCH');
      pause(1_800);
      const [w, h] = size(phone);
      phone.shell(`input tap ${Math.floor(w / 2)} ${Math.floor(h / 2)}`);
      if (!inFront(phone, 6_000)) return undefined;
      return blink(firstScreen(phone, 15_000), "Home, then its card in Recents");
    },
    'P6.blinkScreen': () => {
      phone.key('KEYCODE_SLEEP');
      pause(1_500);
      phone.key('KEYCODE_WAKEUP');
      pause(600);
      phone.shell('wm dismiss-keyguard');
      return blink(firstScreen(phone, 20_000), 'the screen off, then on');
    },
    'P7.diaryWord': () => {
      const off = fieldLearning();
      if (off === undefined) return undefined;
      return { value: off ? 'no' : 'yes', how: `the diary page ${off ? 'tells' : 'does not tell'} the keyboard not to learn (read from Android's input method state)` };
    },
    'P7.codeGroup': () => {
      const off = fieldLearning();
      if (off === undefined) return undefined;
      return { value: off ? 'no' : 'yes', how: `the app's web view ${off ? 'tells' : 'does not tell'} the keyboard not to learn, for every field; read on the diary page` };
    },
  };
  return {
    act(what: Act) {
      if (what === 'pick-long' && !pickInPicker(phone, 'dc-3year.dcbak', 'dc-3year')) {
        const named = find(phone.dump(), /dc-3year/) !== undefined;
        throw new Error(`the file was not picked (${named ? 'it was listed' : 'it was not listed'} in the picker)`);
      }
    },
    answer: key => answers[key]?.(),
  };
}
