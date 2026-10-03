// Golden values that pin the lock's formats forever. Each was computed by an independent reference
// implementation, not by the code under test. A change to any of them means values already stored
// would stop opening: never edit one to make a test pass.
import { toBase64url } from '../../src/vault/encoding.ts';

const filled = (byte: number): string => toBase64url(new Uint8Array(16).fill(byte));

/** Invented 16-byte ids and a salt. */
export const KEY_11 = filled(0x11);
export const KEY_22 = filled(0x22);
export const KEY_33 = filled(0x33);
export const SALT_44 = filled(0x44);

/** An invented row id, and an observation's id made from it. */
export const ROW_ID = '01900000-0000-7000-8000-000000000001';
export const OBSERVATION_ID = `${ROW_ID}|2026-01-05`;

/** KDF settings written in an unsorted order on purpose. */
export const KDF_SAMPLE = { salt: SALT_44, norm: 'utf8-nfc-trim-v1', iterations: 600000, alg: 'pbkdf2-sha256' } as const;

export const AAD_VECTORS = {
  envObservation: '6463310003656e7600013100164552455245524552455245524552455245524552455100036f6273002f30313930303030302d303030302d373030302d383030302d3030303030303030303030317c323032362d30312d3035000172',
  envEntry: '6463310003656e760001310016496949694969496949694969496949694969496949670003656e74002430313930303030302d303030302d373030302d383030302d303030303030303030303031000177',
  wrapPassphrase: '646331000477726170000a7061737370687261736500164d7a4d7a4d7a4d7a4d7a4d7a4d7a4d7a4d7a4d7a4d7700657b22616c67223a2270626b6466322d736861323536222c22697465726174696f6e73223a3630303030302c226e6f726d223a22757466382d6e66632d7472696d2d7631222c2273616c74223a2252455245524552455245524552455245524552455241227d',
  dkWords: '6463310002646b00013100164969496949694969496949694969496949694969496700164d7a4d7a4d7a4d7a4d7a4d7a4d7a4d7a4d7a4d7a4d77',
} as const;

/** Recovery codes: 25 bytes as hex, and how they print. */
export const RECOVERY_VECTORS = [
  { bytes: '00'.repeat(25), text: '00000 00000 00000 00000 00000 00000 00000 00000 0' },
  { bytes: 'ff'.repeat(25), text: 'ZZZZZ ZZZZZ ZZZZZ ZZZZZ ZZZZZ ZZZZZ ZZZZZ ZZZZZ *' },
  { bytes: '000102030405060708090a0b0c0d0e0f101112131415161718', text: '000G4 0R40M 30E20 9185G R38E1 W8124 GK2GA HC5RR U' },
] as const;

/** How a typed passphrase becomes bytes: NFC, trimmed, UTF-8. */
export const NORM_VECTORS = [
  { text: 'caf\u00e9', bytes: '636166c3a9' },
  { text: 'cafe\u0301', bytes: '636166c3a9' },
  { text: '  a b  ', bytes: '612062' },
  { text: '\u00a0x\u3000', bytes: '78' },
] as const;
