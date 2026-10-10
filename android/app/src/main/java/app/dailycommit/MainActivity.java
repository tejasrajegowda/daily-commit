package app.dailycommit;

import android.os.Bundle;
import android.view.WindowManager;
import app.dailycommit.vault.VaultPlugin;
import com.getcapacitor.BridgeActivity;
import com.getcapacitor.CapConfig;
import com.getcapacitor.Logger;

public class MainActivity extends BridgeActivity {

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        // No screenshots, no recording, and a blank picture in recent apps, from the first frame.
        getWindow().setFlags(WindowManager.LayoutParams.FLAG_SECURE, WindowManager.LayoutParams.FLAG_SECURE);
        setRecentsScreenshotEnabled(false);
        // Capacitor's logger logs until it has read the config ("no logging"), and its first line comes
        // before that; giving it the config first means nothing is logged from the first line.
        Logger.init(CapConfig.loadDefault(this));
        // Before the notification plugin starts and makes the same channel its own way.
        ReminderChannel.ensure(this);
        // The vault's plugin, before the bridge is built.
        registerPlugin(VaultPlugin.class);
        super.onCreate(savedInstanceState);
        // The plugin renamed the channel; a second create puts the name back and changes nothing else.
        ReminderChannel.ensure(this);
    }
}
