package app.dailycommit.shell;

import android.Manifest;
import android.app.Activity;
import android.app.KeyguardManager;
import android.app.NotificationManager;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.PowerManager;
import android.os.SystemClock;
import android.provider.DocumentsContract;
import android.util.Log;
import android.view.View;
import androidx.activity.result.ActivityResult;
import androidx.lifecycle.Lifecycle;
import androidx.lifecycle.LifecycleOwner;
import app.dailycommit.R;
import app.dailycommit.vault.Codec;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.Arrays;
import java.util.List;
import java.util.Set;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.regex.Pattern;
import org.json.JSONObject;

/**
 * The phone's side of the app that isn't the vault: when the app counts as left (LockWatch), the
 * black cover, the record's files, "save as" and the file picker, the notification permission,
 * a sleep on the uptime clock, and the timing line. Every system screen it opens is marked as a
 * hand-off the app started itself; a result that arrives after Android ended the app is dropped.
 */
@CapacitorPlugin(name = "Shell", permissions = @Permission(strings = { Manifest.permission.POST_NOTIFICATIONS }, alias = "notifications"))
public class ShellPlugin extends Plugin {

    private interface Body { void run() throws Exception; }

    private static final String TAG = "DailyCommit";
    private static final Set<String> TIMED = Set.of("unlock", "lookback", "restore");
    private static final Pattern EXPORT_NAME = Pattern.compile("backup-\\d{4}-\\d{2}-\\d{2}\\.dcbak");
    private static final int MAX_PICK = 32 * 1024 * 1024;

    private final LockWatch watch = new LockWatch();
    private final Handler main = new Handler(Looper.getMainLooper());
    private final ExecutorService io = Executors.newSingleThreadExecutor();
    /** The start time this timer was armed with. Clearing the mark must not turn the pending leave into nothing. */
    private long timerSince = HandOff.NONE;
    private final Runnable handOffTimer = () -> apply(watch.on(LockWatch.Event.HAND_OFF_TIMER, timerSince, SystemClock.elapsedRealtime(), interactive(), keyguardLocked()));
    private ShellFiles files;
    private byte[] pendingSave;                          // the export, while "save as" is open; memory only

    private final BroadcastReceiver screenOff = new BroadcastReceiver() {
        @Override public void onReceive(Context context, Intent intent) {
            if (Intent.ACTION_SCREEN_OFF.equals(intent.getAction())) event(LockWatch.Event.SCREEN_OFF);
        }
    };

    @Override
    public void load() {
        files = new ShellFiles(getContext().getFilesDir());
        getContext().registerReceiver(screenOff, new IntentFilter(Intent.ACTION_SCREEN_OFF), Context.RECEIVER_NOT_EXPORTED);
    }

    @Override protected void handleOnDestroy() { getContext().unregisterReceiver(screenOff); }
    @Override protected void handleOnPause() { event(LockWatch.Event.PAUSE); }
    @Override protected void handleOnStop() { event(LockWatch.Event.STOP); }
    @Override protected void handleOnResume() {
        main.removeCallbacks(handOffTimer);
        timerSince = HandOff.NONE;
        event(LockWatch.Event.RESUME);
    }

    /** Nothing of a pending call goes into Android's saved state: an export's whole file would. */
    @Override protected Bundle saveInstanceState() { return null; }

    private void event(LockWatch.Event event) {
        long now = SystemClock.elapsedRealtime();
        long since = HandOff.since();
        apply(watch.on(event, since, now, interactive(), keyguardLocked()));
        if (event != LockWatch.Event.RESUME && HandOff.since() != HandOff.NONE) {
            timerSince = HandOff.since();
            main.removeCallbacks(handOffTimer);
            main.postDelayed(handOffTimer, Math.max(0, timerSince + LockWatch.HAND_OFF_LIMIT_MS - now));
        }
    }

    /**
     * The one place a hand-off ends: the fingerprint prompt, the notification question,
     * save-as and the file picker. If the activity is no longer started, LockWatch leaves.
     */
    public void endHandOff() {
        Activity activity = getActivity();
        boolean started = activity instanceof LifecycleOwner owner
            && owner.getLifecycle().getCurrentState().isAtLeast(Lifecycle.State.STARTED);
        apply(watch.handOffEnded(started));
    }

    /** Runs LockWatch's outputs, in order, on the main thread. */
    private void apply(List<LockWatch.Out> outs) {
        Runnable run = () -> {
            View cover = getActivity().findViewById(R.id.dc_cover);
            for (LockWatch.Out out : outs) {
                switch (out) {
                    case COVER: cover.setVisibility(View.VISIBLE); cover.bringToFront(); break;
                    case UNCOVER: cover.setVisibility(View.GONE); break;
                    case SEND_LEAVE: notifyListeners("leave", new JSObject(), true); break;
                    case SEND_RESUME: notifyListeners("resume", new JSObject(), true); break;
                    case END_HAND_OFF: HandOff.end(); break;
                }
            }
        };
        if (Looper.myLooper() == Looper.getMainLooper()) run.run(); else main.post(run);
    }

    @PluginMethod public void drawn(PluginCall call) { apply(watch.drawn()); call.resolve(); }

    // the record's files: one thread, in order; bytes as base64url
    @PluginMethod public void writeFile(PluginCall call) { onIo(call, () -> { files.write(call.getString("path"), Codec.fromBase64url(call.getString("data", ""))); call.resolve(); }); }
    @PluginMethod public void readFile(PluginCall call) {
        onIo(call, () -> {
            byte[] bytes = files.read(call.getString("path"));
            JSObject out = new JSObject();
            out.put("data", bytes == null ? JSONObject.NULL : Codec.toBase64url(bytes));
            call.resolve(out);
        });
    }
    @PluginMethod public void renameFile(PluginCall call) { onIo(call, () -> { files.rename(call.getString("from"), call.getString("to")); call.resolve(); }); }
    @PluginMethod public void listFiles(PluginCall call) {
        onIo(call, () -> {
            JSObject out = new JSObject();
            out.put("names", new JSArray(files.list(call.getString("dir"))));
            call.resolve(out);
        });
    }
    @PluginMethod public void removeFile(PluginCall call) { onIo(call, () -> { files.remove(call.getString("path")); call.resolve(); }); }

    // "save as" (export): a hand-off the app starts; the bytes stay in memory only while it is open
    @PluginMethod public void saveFile(PluginCall call) {
        String name = call.getString("name", "");
        if (!EXPORT_NAME.matcher(name).matches()) { call.reject("Not an export's name.", "bad-input"); return; }
        pendingSave = Codec.fromBase64url(call.getString("data", ""));
        Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE)
            .setType("application/octet-stream").putExtra(Intent.EXTRA_TITLE, name);
        HandOff.begin(SystemClock.elapsedRealtime());
        startActivityForResult(call, intent, "saved");
    }

    @ActivityCallback
    private void saved(PluginCall call, ActivityResult result) {
        endHandOff();
        byte[] bytes = pendingSave;
        pendingSave = null;
        Uri uri = result.getResultCode() == Activity.RESULT_OK && result.getData() != null ? result.getData().getData() : null;
        if (call == null || PluginCall.CALLBACK_ID_DANGLING.equals(call.getCallbackId()) || bytes == null) {
            if (uri != null) deleteQuietly(uri);         // Android ended the app meanwhile (R-3): the empty document goes
            return;
        }
        if (uri == null) { call.resolve(saved(false)); return; }
        io.execute(() -> {
            try (OutputStream out = getContext().getContentResolver().openOutputStream(uri, "wt")) {
                if (out == null) throw new IOException("no stream");
                out.write(bytes);
                out.flush();
                call.resolve(saved(true));
            } catch (IOException | RuntimeException e) {
                deleteQuietly(uri);
                call.reject("The copy wasn't saved.", "not-saved");
            } finally {
                Arrays.fill(bytes, (byte) 0);
            }
        });
    }

    // the file picker (restore): bytes, never a path
    @PluginMethod public void pickFile(PluginCall call) {
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE).setType("*/*");
        HandOff.begin(SystemClock.elapsedRealtime());
        startActivityForResult(call, intent, "picked");
    }

    @ActivityCallback
    private void picked(PluginCall call, ActivityResult result) {
        endHandOff();
        if (call == null || PluginCall.CALLBACK_ID_DANGLING.equals(call.getCallbackId())) return;   // R-3: dropped
        Uri uri = result.getResultCode() == Activity.RESULT_OK && result.getData() != null ? result.getData().getData() : null;
        if (uri == null) { call.resolve(kind("Cancelled")); return; }
        io.execute(() -> {
            try (InputStream in = getContext().getContentResolver().openInputStream(uri)) {
                if (in == null) throw new IOException("no stream");
                byte[] bytes = ShellFiles.readAtMost(in, MAX_PICK);
                if (bytes == null) { call.resolve(kind("TooLarge")); return; }
                JSObject out = kind("Picked");
                out.put("data", Codec.toBase64url(bytes));
                Arrays.fill(bytes, (byte) 0);
                call.resolve(out);
            } catch (IOException | RuntimeException e) {
                call.reject("The file couldn't be read.", "not-read");
            }
        });
    }

    // notifications: asked by the app in context, once; Android's dialog is a hand-off the app starts
    @PluginMethod public void notificationsAllowed(PluginCall call) { call.resolve(allowed(getContext().getSystemService(NotificationManager.class).areNotificationsEnabled())); }

    @PluginMethod public void askNotifications(PluginCall call) {
        if (getPermissionState("notifications") == PermissionState.GRANTED) { call.resolve(allowed(true)); return; }
        HandOff.begin(SystemClock.elapsedRealtime());
        requestPermissionForAlias("notifications", call, "notificationsAnswered");
    }

    @PermissionCallback
    private void notificationsAnswered(PluginCall call) {
        endHandOff();
        call.resolve(allowed(getPermissionState("notifications") == PermissionState.GRANTED));
    }

    /** Resolves after `ms` on the uptime clock (Handler), which Android doesn't hold back the way it does JavaScript's timers. */
    @PluginMethod public void sleep(PluginCall call) {
        int ms = call.getInt("ms", -1);
        if (ms < 0 || ms > 60_000) { call.reject("Not a valid wait.", "bad-input"); return; }
        main.postDelayed(() -> call.resolve(), ms);
    }

    /** Numbers only, three labels, and only while log.tag.DailyCommit is set to VERBOSE. */
    @PluginMethod public void timing(PluginCall call) {
        String label = call.getString("label", "");
        Integer ms = call.getInt("ms");
        if (TIMED.contains(label) && ms != null && ms >= 0 && ms <= 600_000 && Log.isLoggable(TAG, Log.VERBOSE)) Log.v(TAG, label + " " + ms + " ms");
        call.resolve();
    }

    @PluginMethod public void info(PluginCall call) {
        JSObject out = new JSObject();
        out.put("manufacturer", Build.MANUFACTURER);
        out.put("sdk", Build.VERSION.SDK_INT);
        out.put("screenLock", getContext().getSystemService(KeyguardManager.class).isDeviceSecure());
        call.resolve(out);
    }

    private boolean interactive() { return getContext().getSystemService(PowerManager.class).isInteractive(); }
    private boolean keyguardLocked() { return getContext().getSystemService(KeyguardManager.class).isKeyguardLocked(); }

    private void onIo(PluginCall call, Body body) {
        io.execute(() -> {
            try {
                body.run();
            } catch (IllegalArgumentException e) {
                call.reject("Not a valid request.", "bad-input");
            } catch (IOException e) {
                boolean full = String.valueOf(e.getMessage()).contains("ENOSPC") || String.valueOf(e.getMessage()).contains("No space");
                call.reject(full ? "The phone is full." : "The file couldn't be written.", full ? "full" : "io");
            } catch (Exception e) {
                call.reject("The file couldn't be written.", "io");
            }
        });
    }

    private void deleteQuietly(Uri uri) {
        try { DocumentsContract.deleteDocument(getContext().getContentResolver(), uri); } catch (Exception e) { /* the provider may not allow it */ }
    }

    private static JSObject kind(String kind) { JSObject o = new JSObject(); o.put("kind", kind); return o; }
    private static JSObject saved(boolean saved) { JSObject o = new JSObject(); o.put("saved", saved); return o; }
    private static JSObject allowed(boolean allowed) { JSObject o = new JSObject(); o.put("allowed", allowed); return o; }
}
