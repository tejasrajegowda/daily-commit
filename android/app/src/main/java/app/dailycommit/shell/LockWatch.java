package app.dailycommit.shell;

import java.util.ArrayList;
import java.util.List;

/**
 * When the app counts as left (owner D-4, §4.6), decided here and never by a JavaScript timer, and
 * what to do about it: cover the web view, tell the app, and uncover only once it has drawn the
 * blank or lock screen. Plain Java; the caller passes the clocks and the phone's state.
 */
public final class LockWatch {

    public static final long HAND_OFF_LIMIT_MS = 5 * 60 * 1000L;

    public enum Event { SCREEN_OFF, PAUSE, STOP, RESUME, HAND_OFF_TIMER }
    public enum Decision { LEAVE, STAY, RESUME, LEAVE_THEN_RESUME, NOTHING }
    public enum Out { COVER, UNCOVER, SEND_LEAVE, SEND_RESUME, END_HAND_OFF }

    /** `handOffSince` is HandOff.since(), on the elapsed-realtime clock, or HandOff.NONE. */
    public static Decision decideLeave(Event event, long handOffSince, long now, boolean interactive, boolean keyguardLocked) {
        boolean open = handOffSince != HandOff.NONE;
        boolean expired = open && now - handOffSince >= HAND_OFF_LIMIT_MS;
        switch (event) {
            case SCREEN_OFF:
                return Decision.LEAVE;
            case PAUSE:
            case STOP:
                return open && !expired && interactive && !keyguardLocked ? Decision.STAY : Decision.LEAVE;
            case HAND_OFF_TIMER:
                return expired ? Decision.LEAVE : Decision.NOTHING;
            case RESUME:
                return expired ? Decision.LEAVE_THEN_RESUME : Decision.RESUME;
            default:
                throw new IllegalArgumentException("no such event");
        }
    }

    private boolean left;
    private boolean covered;
    private boolean waitingForDrawn;
    /** Start time captured when a hand-off made pause or stop stay. Kept after the mark is cleared, until the app comes back. */
    private long armedAt = HandOff.NONE;

    /** What to do for one event, in order. */
    public synchronized List<Out> on(Event event, long handOffSince, long now, boolean interactive, boolean keyguardLocked) {
        // A timer or a return whose mark was already cleared still uses the time it was armed with.
        long since = handOffSince;
        if (handOffSince == HandOff.NONE && armedAt != HandOff.NONE
                && (event == Event.HAND_OFF_TIMER || event == Event.RESUME)) {
            since = armedAt;
        }
        List<Out> out = new ArrayList<>();
        Decision decision = decideLeave(event, since, now, interactive, keyguardLocked);
        switch (event) {
            case RESUME:
                if (decision == Decision.LEAVE_THEN_RESUME) leave(out);   // a hand-off left open past the limit counts as leaving
                if (handOffSince != HandOff.NONE) out.add(Out.END_HAND_OFF);
                if (left) {
                    left = false;
                    waitingForDrawn = true;                               // the cover stays until the app has drawn
                    out.add(Out.SEND_RESUME);
                } else if (covered) {
                    covered = false;                                      // a hand-off came back in time: nothing changed
                    out.add(Out.UNCOVER);
                }
                armedAt = HandOff.NONE;
                return out;
            case HAND_OFF_TIMER:
                if (decision == Decision.LEAVE) leave(out);
                return out;
            default:                                                      // SCREEN_OFF, PAUSE, STOP
                cover(out);
                if (decision == Decision.STAY) armedAt = handOffSince;
                if (decision == Decision.LEAVE) leave(out);
                return out;
        }
    }

    /**
     * The system screen our own code opened has closed. Ends the mark. If the activity is no
     * longer started, that is a stop with no hand-off, so the app leaves and the cover stays
     * until it has drawn. A dialog still on screen is only paused: the activity is still
     * started, and this does not leave.
     */
    public synchronized List<Out> handOffEnded(boolean started) {
        List<Out> out = new ArrayList<>();
        out.add(Out.END_HAND_OFF);
        if (!started && decideLeave(Event.STOP, HandOff.NONE, 0L, true, false) == Decision.LEAVE) leave(out);
        return out;
    }

    /** The app has drawn the blank or lock screen after coming back. */
    public synchronized List<Out> drawn() {
        List<Out> out = new ArrayList<>();
        if (covered && waitingForDrawn && !left) {
            covered = false;
            waitingForDrawn = false;
            out.add(Out.UNCOVER);
        }
        return out;
    }

    private void cover(List<Out> out) {
        if (!covered) {
            covered = true;
            out.add(Out.COVER);
        }
    }

    private void leave(List<Out> out) {
        cover(out);
        if (!left) {
            left = true;
            waitingForDrawn = false;
            out.add(Out.SEND_LEAVE);
        }
    }
}
