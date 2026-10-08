package app.dailycommit;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.content.Context;

/**
 * The one channel reminders use. It has the notification plugin's own channel id and is made
 * before the plugin starts: Android keeps an existing channel's sound, badge and lock-screen
 * setting, so the plugin's louder defaults never apply. Silent, no dot on the icon, and on a
 * locked phone only the app's name unless the phone's own setting shows more.
 */
final class ReminderChannel {

    static final String ID = "default";

    private ReminderChannel() {}

    static void ensure(Context context) {
        NotificationChannel channel = new NotificationChannel(ID, "Reminders", NotificationManager.IMPORTANCE_LOW);
        channel.setShowBadge(false);
        channel.setLockscreenVisibility(Notification.VISIBILITY_PRIVATE);
        channel.setSound(null, null);
        channel.enableVibration(false);
        channel.enableLights(false);
        context.getSystemService(NotificationManager.class).createNotificationChannel(channel);
    }
}
