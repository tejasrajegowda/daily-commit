package app.dailycommit.shell;

/**
 * The system screen our own code opened and is waiting on, if any (owner D-4: only a hand-off the
 * app started itself is exempt from locking). In memory only, so a process Android ended during
 * the hand-off comes back with none, and locked.
 */
public final class HandOff {
    public static final long NONE = -1;
    private static long since = NONE;

    private HandOff() {}

    /** `now` is SystemClock.elapsedRealtime(): it keeps counting while the phone sleeps. */
    public static synchronized void begin(long now) { since = now; }
    public static synchronized void end() { since = NONE; }
    public static synchronized long since() { return since; }
}
