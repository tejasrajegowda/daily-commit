// Where the Android tools are on this PC, for the build and check scripts. The paths are built from
// the user's own folders (LOCALAPPDATA, USERPROFILE) at run time and handed only to child processes:
// nothing is written into the repo or into the parent's environment.
import { delimiter, join } from 'node:path';

export const BUILD_TOOLS = '36.0.0';
export const PLATFORM = 'android-36';

export interface Toolchain { readonly jdk: string; readonly sdk: string }

type Env = Readonly<Record<string, string | undefined>>;

/** JDK 21 and the Android SDK where this PC keeps them; DC_JDK / DC_ANDROID_SDK override. Throws if the base folders are unset. */
export function toolchain(env: Env): Toolchain {
  const jdk = env.DC_JDK ?? (env.LOCALAPPDATA ? join(env.LOCALAPPDATA, 'Programs', 'jdk-21') : undefined);
  const sdk = env.DC_ANDROID_SDK ?? (env.USERPROFILE ? join(env.USERPROFILE, 'Android', 'Sdk') : undefined);
  if (!jdk || !sdk) throw new Error('LOCALAPPDATA and USERPROFILE must be set (or DC_JDK and DC_ANDROID_SDK)');
  return { jdk, sdk };
}

/** The environment for one child process: JAVA_HOME, ANDROID_HOME, ANDROID_SDK_ROOT, and PATH with the tools first. Never written anywhere. */
export function childEnv(tc: Toolchain, env: Env): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) if (v !== undefined) out[k] = v;
  const key = 'PATH' in out ? 'PATH' : 'Path' in out ? 'Path' : 'PATH';
  const first = [
    join(tc.jdk, 'bin'),
    join(tc.sdk, 'platform-tools'),
    join(tc.sdk, 'emulator'),
    join(tc.sdk, 'cmdline-tools', 'latest', 'bin'),
    join(tc.sdk, 'build-tools', BUILD_TOOLS),
  ];
  out[key] = [...first, ...(out[key] ? [out[key]] : [])].join(delimiter);
  out.JAVA_HOME = tc.jdk;
  out.ANDROID_HOME = tc.sdk;
  out.ANDROID_SDK_ROOT = tc.sdk;
  return out;
}

/** Paths of the tools a build or a check needs, by name. */
export function toolPaths(tc: Toolchain): Readonly<Record<'java' | 'keytool' | 'adb' | 'emulator' | 'sdkmanager' | 'avdmanager' | 'apkanalyzer' | 'apksigner' | 'zipalign' | 'platform', string>> {
  const bin = join(tc.sdk, 'cmdline-tools', 'latest', 'bin');
  const tools = join(tc.sdk, 'build-tools', BUILD_TOOLS);
  return {
    java: join(tc.jdk, 'bin', 'java.exe'),
    keytool: join(tc.jdk, 'bin', 'keytool.exe'),
    adb: join(tc.sdk, 'platform-tools', 'adb.exe'),
    emulator: join(tc.sdk, 'emulator', 'emulator.exe'),
    sdkmanager: join(bin, 'sdkmanager.bat'),
    avdmanager: join(bin, 'avdmanager.bat'),
    apkanalyzer: join(bin, 'apkanalyzer.bat'),
    apksigner: join(tools, 'apksigner.bat'),
    zipalign: join(tools, 'zipalign.exe'),
    platform: join(tc.sdk, 'platforms', PLATFORM, 'android.jar'),
  };
}

/** The names of the tools that aren't there. */
export function missingTools(tc: Toolchain, exists: (path: string) => boolean): string[] {
  return Object.entries(toolPaths(tc)).filter(([, p]) => !exists(p)).map(([name]) => name);
}
