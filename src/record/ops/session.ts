import type { RowCipher } from '../../vault/cipher.ts';
import type { RecordCore } from '../core.ts';
import { sweepTrash } from './words.ts';

/** Unlocks the record, then wipes anything whose 7 days in the trash are over. The app unlocks through this. */
export async function openSession(core: RecordCore, cipher: RowCipher): Promise<void> {
  await core.unlock(cipher);
  await sweepTrash(core);
}
