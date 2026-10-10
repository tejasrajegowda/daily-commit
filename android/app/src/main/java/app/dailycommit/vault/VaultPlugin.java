package app.dailycommit.vault;

import android.app.KeyguardManager;
import android.hardware.biometrics.BiometricManager;
import android.hardware.biometrics.BiometricPrompt;
import android.os.CancellationSignal;
import android.os.SystemClock;
import app.dailycommit.shell.HandOff;
import app.dailycommit.shell.ShellPlugin;
import com.getcapacitor.Bridge;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginHandle;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.File;
import java.io.IOException;
import java.security.SecureRandom;
import java.util.Arrays;
import java.util.concurrent.Executor;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.function.Consumer;
import org.json.JSONObject;

/**
 * The vault's five calls (src/vault/plugin.ts). The work runs on one thread, in order; the phone's
 * own prompt runs on the main thread and is marked as a hand-off the app started itself.
 * Ending that mark goes through the shell, which locks if the activity is no longer started.
 * Nothing here logs.
 */
@CapacitorPlugin(name = "Vault")
public class VaultPlugin extends Plugin {

    private interface Body { void run() throws Exception; }

    private final ExecutorService worker = Executors.newSingleThreadExecutor();
    private VaultCore core;
    private AndroidKeys keys;
    private boolean prompting;                         // main thread only

    @Override
    public void load() {
        try {
            keys = new AndroidKeys();
            core = new VaultCore(new File(getContext().getNoBackupFilesDir(), "vault"), keys, new SecureRandom());
        } catch (Exception e) {
            core = null;                                // every call then answers "refused"
        }
    }

    @PluginMethod
    public void status(PluginCall call) {
        run(call, () -> {
            JSArray modes = new JSArray();
            for (VaultCore.Mode mode : core.status()) modes.put(mode.id);
            String codeAlias = core.aliasOf(VaultCore.Mode.OWN_CODE);
            String level = codeAlias == null ? null : keys.levelOf(codeAlias);
            JSObject out = new JSObject();
            out.put("modes", modes);
            // put(name, null) drops the name. The bridge must see codeKey as null.
            out.put("codeKey", level == null ? JSONObject.NULL : level);
            call.resolve(out);
        });
    }

    @PluginMethod
    public void enrol(PluginCall call) {
        run(call, () -> {
            VaultCore.Mode mode = VaultCore.Mode.of(call.getString("mode", ""));
            byte[] key = Codec.fromBase64url(call.getString("masterKey", ""));
            try {
                if (mode == VaultCore.Mode.OWN_CODE) {
                    core.enrolCode(key, call.getString("code"));
                    call.resolve();
                    return;
                }
                if (!getContext().getSystemService(KeyguardManager.class).isDeviceSecure()) {
                    call.reject("This phone has no screen lock.", "no-screen-lock");
                    return;
                }
                VaultCore.Step step = core.beginEnrol(mode, key);
                prompt(step, mode == VaultCore.Mode.FINGERPRINT ? "Not now" : null, allowed -> run(call, () -> {
                    if (!allowed) {
                        core.cancelled(step);
                        call.reject("Backed out of the phone's prompt.", "cancelled");
                        return;
                    }
                    core.finishEnrol(step);
                    call.resolve();
                }));
            } finally {
                Arrays.fill(key, (byte) 0);
            }
        });
    }

    @PluginMethod
    public void unwrap(PluginCall call) {
        run(call, () -> {
            VaultCore.Mode mode = VaultCore.Mode.of(call.getString("mode", ""));
            VaultCore.Step step = core.beginOpen(mode);
            if (step == null) {
                call.resolve(kind("Missing"));
                return;
            }
            prompt(step, mode == VaultCore.Mode.FINGERPRINT ? "Use your code" : null, allowed -> run(call, () -> {
                if (!allowed) {
                    core.cancelled(step);
                    call.resolve(kind("Cancelled"));
                    return;
                }
                VaultCore.Opened opened = core.finishOpen(step);
                call.resolve(opened.kind == VaultCore.Opened.Kind.KEY ? keyResult(opened.key()) : kind("Missing"));
            }));
        });
    }

    @PluginMethod
    public void verifyCode(PluginCall call) {
        run(call, () -> {
            VaultCore.CodeCheck check = core.verifyCode(call.getString("code", ""));
            if (check.kind == VaultCore.CodeCheck.Kind.KEY) {
                call.resolve(keyResult(check.key()));
            } else if (check.kind == VaultCore.CodeCheck.Kind.WRONG_CODE) {
                JSObject out = kind("WrongCode");
                out.put("triesLeft", check.triesLeft);
                call.resolve(out);
            } else {
                call.resolve(kind("Missing"));
            }
        });
    }

    @PluginMethod
    public void remove(PluginCall call) {
        run(call, () -> {
            try {
                core.remove(VaultCore.Mode.of(call.getString("mode", "")));
                call.resolve();
            } catch (IOException e) {
                call.reject("The copy is still on the phone.", "copy-kept");
            }
        });
    }

    /** The phone's own prompt for one key use. A strong fingerprint only when `negative` is set; else the fingerprint or the phone's PIN. */
    private void prompt(VaultCore.Step step, String negative, Consumer<Boolean> done) {
        getActivity().runOnUiThread(() -> {
            if (prompting) {
                done.accept(false);
                return;
            }
            prompting = true;
            HandOff.begin(SystemClock.elapsedRealtime());
            Executor main = getContext().getMainExecutor();
            BiometricPrompt.Builder builder = new BiometricPrompt.Builder(getActivity()).setTitle("Daily Commit");
            if (negative == null) {
                builder.setAllowedAuthenticators(BiometricManager.Authenticators.BIOMETRIC_STRONG | BiometricManager.Authenticators.DEVICE_CREDENTIAL);
            } else {
                builder.setAllowedAuthenticators(BiometricManager.Authenticators.BIOMETRIC_STRONG)
                    .setNegativeButton(negative, main, (dialog, which) -> finished(done, false));
            }
            builder.build().authenticate(new BiometricPrompt.CryptoObject(step.cipher), new CancellationSignal(), main,
                new BiometricPrompt.AuthenticationCallback() {
                    @Override public void onAuthenticationSucceeded(BiometricPrompt.AuthenticationResult result) { finished(done, true); }
                    @Override public void onAuthenticationError(int code, CharSequence message) { finished(done, false); }
                });
        });
    }

    private void finished(Consumer<Boolean> done, boolean allowed) {
        prompting = false;
        endHandOff();
        done.accept(allowed);
    }

    /** The shell is the one place a hand-off ends. If it is not loaded, the mark still ends. */
    private void endHandOff() {
        Bridge bridge = getBridge();
        PluginHandle handle = bridge == null ? null : bridge.getPlugin("Shell");
        if (handle != null && handle.getInstance() instanceof ShellPlugin shell) {
            shell.endHandOff();
            return;
        }
        HandOff.end();
    }

    private void run(PluginCall call, Body body) {
        worker.execute(() -> {
            if (core == null) {
                call.reject("The phone's key store is not available.", "refused");
                return;
            }
            try {
                body.run();
            } catch (IllegalArgumentException e) {
                call.reject("Not a valid request.", "bad-input");
            } catch (Exception e) {
                call.reject("The phone's key store refused.", "refused");
            }
        });
    }

    private static JSObject kind(String kind) {
        JSObject out = new JSObject();
        out.put("kind", kind);
        return out;
    }

    private static JSObject keyResult(byte[] key) {
        JSObject out = kind("Key");
        out.put("masterKey", Codec.toBase64url(key));
        Arrays.fill(key, (byte) 0);
        return out;
    }
}
