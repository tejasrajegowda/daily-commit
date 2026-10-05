// The recovery code as it is drawn: eight groups of five, then the one-character check symbol.

/** The printed code's groups, as shown on paper. */
export function codeGroups(code: string): string[] {
  return code.trim().split(/\s+/);
}

/** What has been typed back so far: finished groups of five, and the group being typed. */
export function typedGroups(typed: string): { readonly done: string[]; readonly current: string } {
  const chars = typed.toUpperCase().replace(/[\s-]/g, '');
  const done: string[] = [];
  let at = 0;
  for (; at + 5 <= Math.min(chars.length, 40); at += 5) done.push(chars.slice(at, at + 5));
  return { done, current: chars.slice(at) };
}
