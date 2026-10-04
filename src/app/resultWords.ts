import type { Result } from '../record/results.ts';

// The words for a save that didn't go through. The screen keeps what was typed and shows these;
// it never treats a refusal as done.

export function resultWords(result: Result<unknown>): { readonly title: string; readonly text: string } | undefined {
  switch (result.kind) {
    case 'Saved': return undefined;
    case 'Sealed': return { title: 'Not saved', text: "That day has sealed. Days seal after a day and a half, so there's never a question of going back to fix something." };
    case 'QuotaFull': return { title: 'Not saved yet', text: 'The phone is out of space. What you wrote is still here. Free some space, and it saves the next time you tap.' };
    case 'Locked': return { title: 'Not saved', text: 'Daily Commit locked before this could be saved.' };
    case 'Invalid': return { title: 'Not saved', text: "Something in it can't be saved as it is. What you wrote is still here." };
  }
}
