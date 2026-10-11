import type { VaultPlugin } from '../vault/plugin.ts';

// How long the phone may take to answer a call that needs no one's finger. Past it the unlock ends
// with words, never "Opening…" for good (U4 R1-8). The prompt itself has no limit here: the
// person is in Android's own screen, and it ends itself.

export const PHONE_ANSWER_MS = 15_000;

const SILENT = 'PhoneSilent';
export const isSilent = (e: unknown): boolean => e instanceof Error && e.name === SILENT;

function limited<T>(call: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, fail) => {
    timer = setTimeout(() => fail(Object.assign(new Error("The phone's lock didn't answer."), { name: SILENT })), ms);
  });
  return Promise.race([call, late]).finally(() => clearTimeout(timer));
}

/** The plugin, with `status` and `verifyCode` given up on after `ms`. */
export function answering(plugin: VaultPlugin, ms: number = PHONE_ANSWER_MS): VaultPlugin {
  return { ...plugin, status: () => limited(plugin.status(), ms), verifyCode: code => limited(plugin.verifyCode(code), ms) };
}
