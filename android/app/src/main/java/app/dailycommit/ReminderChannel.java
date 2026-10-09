package app.dailycommit;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.content.Context;

/**
 * The one channel reminders use. It has the notification plugin's own channel id and is made
 * before the plugin starts: Android keeps an existing channel's sound and badge, so the plugin's
 * louder defaults never apply. Silent and no dot on the icon. The lock screen is not decided here:
 * Android replaces an app's own lock-screen setting on a new channel with "no override", so each
 * notification's own visibility decides, and the plugin builds every one private (only the app's
 * name on a locked phone, unless the phone's own setting shows more).
 */
final class ReminderChannel {

    static final String ID = "default";

    private ReminderChannel() {}

    static void ensure(Context context) {
        NotificationChannel channel = new NotificationChannel(ID, "Reminders", NotificationManager.IMPORTANCE_LOW);
        channel.setShowBadge(false);
        // Ignored by Android 13 (see above); asked for anyway, in case a later Android honours it.
        channel.setLockscreenVisibility(Notification.VISIBILITY_PRIVATE);
        channel.setSound(null, null);
        channel.enableVibration(false);
        channel.enableLights(false);
        context.getSystemService(NotificationManager.class).createNotificationChannel(channel);
    }
}
