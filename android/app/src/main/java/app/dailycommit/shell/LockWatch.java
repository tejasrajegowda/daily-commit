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

    /** What to do for one event, in order. */
    public synchronized List<Out> on(Event event, long handOffSince, long now, boolean interactive, boolean keyguardLocked) {
        List<Out> out = new ArrayList<>();
        Decision decision = decideLeave(event, handOffSince, now, interactive, keyguardLocked);
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
                return out;
            case HAND_OFF_TIMER:
                if (decision == Decision.LEAVE) leave(out);
                return out;
            default:                                                      // SCREEN_OFF, PAUSE, STOP
                cover(out);
                if (decision == Decision.LEAVE) leave(out);
                return out;
        }
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
