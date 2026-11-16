// The screen when the app couldn't start (D-37). It says what is true: nothing was opened or changed and the
// record is still on the phone. The code names only the step and the error's type, so it can be passed on
// without carrying anything from the record.
export const START_FAILED_WORDS = {
  title: "Daily Commit couldn't start",
  text: 'Something went wrong while it was opening. Nothing was opened or changed, and your record is still on this phone.',
  fix: "Close it and open it again. If this keeps happening, an update will fix it. Uninstalling isn't needed, and would remove the record from this phone.",
  code: (step: string, error: string) => `Code: ${step} · ${error}`,
  version: (v: string) => `This phone has version ${v}.`,
} as const;
