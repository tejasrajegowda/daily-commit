package app.dailycommit;

import android.content.Context;
import android.util.AttributeSet;
import android.view.inputmethod.EditorInfo;
import android.view.inputmethod.InputConnection;
import com.getcapacitor.CapacitorWebView;

/**
 * The app's web view. Every field it opens asks the keyboard not to learn what is typed into it.
 * A keyboard may ignore the request; Task 9 checks the phone's own.
 */
public class PrivateWebView extends CapacitorWebView {

    public PrivateWebView(Context context, AttributeSet attrs) {
        super(context, attrs);
    }

    @Override
    public InputConnection onCreateInputConnection(EditorInfo outAttrs) {
        InputConnection connection = super.onCreateInputConnection(outAttrs);
        outAttrs.imeOptions |= EditorInfo.IME_FLAG_NO_PERSONALIZED_LEARNING;
        return connection;
    }
}
