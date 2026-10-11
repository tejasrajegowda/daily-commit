// The refusal when the record was saved by a newer version (C10). No buttons: installing the newer
// version fixes it, and the one step that would lose the record is said not to be needed.
export const TOO_OLD_WORDS = {
  title: 'This app is older than your record',
  text: "Your record was saved by a newer version of Daily Commit, so this version can't open it. Nothing was opened or changed.",
  fix: "Installing the newer version over this one brings everything back as it was. Uninstalling isn't needed, and would remove the record from this phone.",
  version: (v: string) => `This phone has version ${v}.`,
} as const;
