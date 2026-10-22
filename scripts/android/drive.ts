// Driving the test phone: a uiautomator dump turned into nodes, and adb aimed only at emulator-5556.
// Every call names that serial. Nothing else is ever addressed.
import { EMULATOR_SERIAL, runAdb } from './adbGate.ts';

export const TEST_SERIAL = EMULATOR_SERIAL;

/** One node of a `uiautomator dump`. */
export interface UiNode {
  readonly text: string;
  readonly desc: string;
  readonly id: string;
  readonly cls: string;
  readonly bounds: readonly [number, number, number, number];
  readonly enabled: boolean;
  /** The package the node belongs to, when the dump says. */
  readonly pkg?: string;
}

const ENTITY: Readonly<Record<string, string>> = { amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", apos: "'" };

function decode(s: string): string {
  return s.replace(/&(amp|lt|gt|quot|#39|apos);/g, (whole, name: string) => ENTITY[name] ?? whole);
}

/** Every node of a dump, attributes decoded (&amp; &lt; &gt; &quot; &#39; &apos;). */
export function nodesOf(xml: string): UiNode[] {
  const nodes: UiNode[] = [];
  for (const m of xml.matchAll(/<node\b([^>]*)\/?>/g)) {
    const attrs = m[1] ?? '';
    const map = new Map<string, string>();
    for (const a of attrs.matchAll(/([^\s=]+)="([^"]*)"/g)) map.set(a[1] ?? '', decode(a[2] ?? ''));
    const b = /\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]/.exec(map.get('bounds') ?? '');
    const n = (i: number) => (b?.[i] === undefined ? 0 : Number(b[i]));
    nodes.push({
      text: map.get('text') ?? '',
      desc: map.get('content-desc') ?? '',
      id: map.get('resource-id') ?? '',
      cls: map.get('class') ?? '',
      bounds: [n(1), n(2), n(3), n(4)],
      enabled: map.get('enabled') === 'true',
      pkg: map.get('package') ?? '',
    });
  }
  return nodes;
}

function hit(value: string, label: string | RegExp): boolean {
  if (typeof label === 'string') return value.trim() === label.trim();
  if (label.global) label.lastIndex = 0;
  return label.test(value);
}

/** The first node whose text or content-desc is this (a string matches whole, after trimming; a RegExp tests). */
export function find(nodes: readonly UiNode[], label: string | RegExp): UiNode | undefined {
  return nodes.find(n => hit(n.text, label) || hit(n.desc, label));
}

/** A button when a title and a button share the words; otherwise the first match. */
export function findClickable(nodes: readonly UiNode[], label: string | RegExp): UiNode | undefined {
  const hits = nodes.filter(n => hit(n.text, label) || hit(n.desc, label));
  return hits.find(n => n.enabled && n.cls.includes('Button')) ?? hits.find(n => n.enabled) ?? hits[0];
}

export type PickerMove = 'file' | 'downloads' | 'roots' | 'scroll';

/** Where to go in DocumentsUI. Downloads is preferred once the drawer shows it; the list is scrolled only after that. */
export function pickerMove(labels: readonly string[], inList: boolean, stem = 'dc-seed'): PickerMove {
  const hit = (needle: string) => labels.some(label => label.toLowerCase().includes(needle));
  if (hit(stem)) return 'file';
  if (!inList && hit('downloads')) return 'downloads';
  if (!inList && hit('show roots')) return 'roots';
  return 'scroll';
}

/** A node with no area is in the tree and not on screen. Taps ignore it. */
export function onScreen(n: UiNode): boolean {
  return n.bounds[2] > n.bounds[0] && n.bounds[3] > n.bounds[1];
}

/** The node's centre sits inside the screen. A row below the fold is in the tree and not tappable yet. */
export function inView(n: UiNode, width: number, height: number): boolean {
  if (!onScreen(n)) return false;
  const cx = (n.bounds[0] + n.bounds[2]) / 2;
  const cy = (n.bounds[1] + n.bounds[3]) / 2;
  return cx >= 0 && cy >= 0 && cx < width && cy < height;
}

const DOCK_LABELS = new Set(['today', 'look back', 'diary', 'plan']);

/** The top of the phone dock. One button that happens to share a dock word is not the dock. */
export function dockTop(nodes: readonly UiNode[], height: number): number {
  const tops = nodes
    .filter(n => n.enabled && n.cls.includes('Button'))
    .filter(n => DOCK_LABELS.has((n.text || n.desc).trim().toLowerCase()))
    .filter(n => n.bounds[3] > height * 0.75 && n.bounds[1] > height * 0.5)
    .map(n => n.bounds[1]);
  if (tops.length < 2) return height;
  return Math.min(...tops);
}

/** In view, and its centre is above the dock, so a tap lands on the row. */
export function aboveDock(n: UiNode, width: number, height: number, top: number): boolean {
  if (!inView(n, width, height)) return false;
  const cy = (n.bounds[1] + n.bounds[3]) / 2;
  return cy < top;
}

export function centre(n: UiNode): readonly [number, number] {
  return [Math.floor((n.bounds[0] + n.bounds[2]) / 2), Math.floor((n.bounds[1] + n.bounds[3]) / 2)];
}

// `adb shell input text` takes one argument. The device shell still parses it, so its specials are escaped.
const SHELL_SPECIAL = new Set("\\'\"$&|;<>()[]{}*?!~`^#".split(''));

/** `adb shell input text` takes one argument: plain ASCII, spaces as %s, the shell's specials escaped; no '%'. */
export function inputTextArg(text: string): string {
  for (const ch of text) {
    if (ch === '%' || ch.charCodeAt(0) > 0x7f) throw new Error('input text must be plain ASCII and must not contain %');
  }
  let out = '';
  for (const ch of text) out += ch === ' ' ? '%s' : SHELL_SPECIAL.has(ch) ? `\\${ch}` : ch;
  return out;
}

export interface Emu {
  shell(command: string): { readonly code: number; readonly out: string };
  execOut(args: readonly string[]): Uint8Array;
  dump(): UiNode[];
  /** The xml of the last dump(), for the run's saved copy. */
  lastXml(): string;
  tap(label: string | RegExp, timeoutMs?: number): void;
  type(text: string): void;
  key(code: string): void;
  waitFor(label: string | RegExp, timeoutMs?: number): boolean;
  gone(label: string | RegExp, timeoutMs?: number): boolean;
  finger(): void;
}

const MAX_BUFFER = 32 * 1024 * 1024;

/** One adb command. The serial is always emulator-5556; a different `-s` is refused. */
export function adbOnTestPhone(args: readonly string[], timeoutMs = 60_000): { readonly code: number; readonly out: string } {
  const ran = runAdb('emulator', ['-s', TEST_SERIAL, ...args], { timeoutMs, encoding: 'utf8', maxBuffer: MAX_BUFFER });
  return { code: ran.status ?? 1, out: ran.out };
}

function adbBytes(args: readonly string[], timeoutMs: number): Uint8Array {
  const ran = runAdb('emulator', ['-s', TEST_SERIAL, ...args], { timeoutMs, maxBuffer: MAX_BUFFER });
  return ran.stdout;
}

/** A blocking wait. The emulator checks are synchronous; this does not need the event loop. */
export function pause(ms: number): void {
  const view = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(view, 0, 0, ms);
}

function labelOf(label: string | RegExp): string {
  return typeof label === 'string' ? label : label.source;
}

/** What a driver needs from one device. The emulator's and the phone's differ only here. */
export interface DeviceIo {
  shell(command: string): { readonly code: number; readonly out: string };
  execOut(args: readonly string[]): Uint8Array;
  /** One screen dump: the nodes a driver may read, and the xml it may keep ('' when it keeps none). Undefined when the dump failed. */
  dump(): { readonly xml: string; readonly nodes: UiNode[] } | undefined;
  finger(): void;
}

function testPhoneIo(): DeviceIo {
  const io: DeviceIo = {
    shell: command => adbOnTestPhone(['shell', command]),
    execOut: args => adbBytes(['exec-out', ...args], 60_000),
    dump() {
      const dumped = io.shell('uiautomator dump /sdcard/dc-ui.xml');
      const cat = io.shell('cat /sdcard/dc-ui.xml');
      io.shell('rm -f /sdcard/dc-ui.xml');
      if (dumped.code !== 0 || !cat.out.includes('<hierarchy')) return undefined;
      return { xml: cat.out, nodes: nodesOf(cat.out) };
    },
    finger() {
      const r = adbOnTestPhone(['emu', 'finger', 'touch', '1']);
      if (r.code !== 0) throw new Error(`finger failed (${r.code})`);
    },
  };
  return io;
}

export function emu(): Emu {
  return driver(testPhoneIo());
}

/** Taps, typing and waits over one device's io. Every read goes through `io.dump()`, every action through `io.shell()`. */
export function driver(io: DeviceIo): Emu {
  let xml = '';
  const phone: Emu = {
    shell: command => io.shell(command),
    execOut: args => io.execOut(args),
    dump() {
      for (let i = 0; i < 3; i++) {
        const got = io.dump();
        if (got !== undefined) {
          xml = got.xml;
          return got.nodes;
        }
        pause(400);
      }
      xml = '';
      return [];
    },
    lastXml: () => xml,
    tap(label, timeoutMs = 30_000) {
      const node = waitNode(phone, label, timeoutMs, true);
      if (!node) {
        const labels = nodesOf(xml).map(n => (n.text || n.desc).replace(/\s+/g, ' ').trim()).filter(t => t.length > 0 && t.length < 60).slice(0, 8);
        throw new Error(`tap: ${labelOf(label)} was not on screen (${labels.join(' | ') || 'no words'})`);
      }
      const [x, y] = centre(node);
      const r = phone.shell(`input tap ${x} ${y}`);
      if (r.code !== 0) throw new Error(`tap failed (${r.code})`);
    },
    type(text: string) {
      const r = phone.shell(`input text ${inputTextArg(text)}`);
      if (r.code !== 0) throw new Error(`type failed (${r.code})`);
    },
    key(code: string) {
      if (!/^[A-Z0-9_]+$/.test(code)) throw new Error('key code must be a keyevent name');
      let last = 'no output';
      for (let i = 0; i < 4; i++) {
        const r = phone.shell(`input keyevent ${code}`);
        if (r.code === 0) return;
        last = r.out.replace(/\s+/g, ' ').trim().slice(0, 140) || `code ${r.code}`;
        pause(800);
      }
      throw new Error(`key failed (${last})`);
    },
    waitFor(label, timeoutMs = 30_000) {
      return waitNode(phone, label, timeoutMs, false) !== undefined;
    },
    gone(label, timeoutMs = 30_000) {
      const until = Date.now() + timeoutMs;
      for (;;) {
        if (!find(phone.dump(), label)) return true;
        if (Date.now() >= until) return false;
        pause(400);
      }
    },
    finger: () => io.finger(),
  };
  return phone;
}

function viewOf(phone: Emu): readonly [number, number] {
  const out = phone.shell('wm size').out;
  const m = /Override size: (\d+)x(\d+)/.exec(out) ?? /Physical size: (\d+)x(\d+)/.exec(out);
  return [Number(m?.[1] ?? 1080), Number(m?.[2] ?? 2400)];
}

function waitNode(phone: Emu, label: string | RegExp, timeoutMs: number, needEnabled: boolean): UiNode | undefined {
  const [w, h] = viewOf(phone);
  const until = Date.now() + timeoutMs;
  for (;;) {
    const shown = phone.dump().filter(n => (hit(n.text, label) || hit(n.desc, label)) && inView(n, w, h));
    const enabled = needEnabled ? shown.filter(n => n.enabled) : shown;
    const hits = enabled.length > 0 ? enabled : shown;
    const node = hits.find(n => n.cls.includes('Button')) ?? hits[0];
    if (node) return node;
    if (Date.now() >= until) return undefined;
    pause(400);
  }
}
