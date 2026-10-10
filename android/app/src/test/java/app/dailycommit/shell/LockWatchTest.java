package app.dailycommit.shell;

import static app.dailycommit.shell.LockWatch.Decision.LEAVE;
import static app.dailycommit.shell.LockWatch.Decision.LEAVE_THEN_RESUME;
import static app.dailycommit.shell.LockWatch.Decision.NOTHING;
import static app.dailycommit.shell.LockWatch.Decision.RESUME;
import static app.dailycommit.shell.LockWatch.Decision.STAY;
import static app.dailycommit.shell.LockWatch.Event;
import static app.dailycommit.shell.LockWatch.HAND_OFF_LIMIT_MS;
import static app.dailycommit.shell.LockWatch.Out.COVER;
import static app.dailycommit.shell.LockWatch.Out.END_HAND_OFF;
import static app.dailycommit.shell.LockWatch.Out.SEND_LEAVE;
import static app.dailycommit.shell.LockWatch.Out.SEND_RESUME;
import static app.dailycommit.shell.LockWatch.Out.UNCOVER;
import static app.dailycommit.shell.LockWatch.decideLeave;
import static org.junit.Assert.assertEquals;

import java.util.List;
import org.junit.Test;

public class LockWatchTest {

    private static final long NOW = 1_000_000_000L;
    private static final long NONE = HandOff.NONE;
    private static final long FRESH = NOW - 1_000;                  // a hand-off begun a second ago
    private final LockWatch watch = new LockWatch();

    private List<LockWatch.Out> on(Event e, long since, long now) { return watch.on(e, since, now, true, false); }

    // the decision alone (C16)
    @Test public void theScreenGoingOffAlwaysLeaves() {
        assertEquals(LEAVE, decideLeave(Event.SCREEN_OFF, FRESH, NOW, true, false));
        assertEquals(LEAVE, decideLeave(Event.SCREEN_OFF, NONE, NOW, true, false));
    }

    @Test public void leavingWithNoHandOffLeaves() {
        assertEquals(LEAVE, decideLeave(Event.PAUSE, NONE, NOW, true, false));
        assertEquals(LEAVE, decideLeave(Event.STOP, NONE, NOW, true, false));
    }

    @Test public void aHandOffOurCodeStartedHoldsForUnderFiveMinutes() {
        assertEquals(STAY, decideLeave(Event.PAUSE, FRESH, NOW, true, false));
        assertEquals(STAY, decideLeave(Event.STOP, NOW - HAND_OFF_LIMIT_MS + 1, NOW, true, false));
        assertEquals(LEAVE, decideLeave(Event.PAUSE, NOW - HAND_OFF_LIMIT_MS, NOW, true, false));
    }

    @Test public void aHandOffNeverHoldsWithTheScreenOffOrTheKeyguardShowing() {
        assertEquals(LEAVE, decideLeave(Event.PAUSE, FRESH, NOW, false, false));
        assertEquals(LEAVE, decideLeave(Event.PAUSE, FRESH, NOW, true, true));
    }

    @Test public void theTimerLeavesOnlyOnceTheLimitIsReached() {
        assertEquals(NOTHING, decideLeave(Event.HAND_OFF_TIMER, FRESH, NOW, true, false));
        assertEquals(LEAVE, decideLeave(Event.HAND_OFF_TIMER, NOW - HAND_OFF_LIMIT_MS, NOW, true, false));
        assertEquals(NOTHING, decideLeave(Event.HAND_OFF_TIMER, NONE, NOW, true, false));
    }

    @Test public void comingBackFromAHandOffPastTheLimitLeavesFirst() {
        assertEquals(RESUME, decideLeave(Event.RESUME, FRESH, NOW, true, false));
        assertEquals(RESUME, decideLeave(Event.RESUME, NONE, NOW, true, false));
        assertEquals(LEAVE_THEN_RESUME, decideLeave(Event.RESUME, NOW - HAND_OFF_LIMIT_MS, NOW, true, false));
    }

    // what follows from it (C9, RF1)
    @Test public void leavingCoversAndSendsLeaveOnce() {
        assertEquals(List.of(COVER, SEND_LEAVE), on(Event.PAUSE, NONE, NOW));
        assertEquals(List.of(), on(Event.STOP, NONE, NOW));
        assertEquals(List.of(), on(Event.SCREEN_OFF, NONE, NOW));
    }

    @Test public void comingBackSendsResume_andTheCoverStaysUntilTheAppHasDrawn() {
        on(Event.PAUSE, NONE, NOW);
        assertEquals(List.of(SEND_RESUME), on(Event.RESUME, NONE, NOW + 5));
        assertEquals(List.of(UNCOVER), watch.drawn());
        assertEquals(List.of(), watch.drawn());
    }

    @Test public void drawnBeforeComingBackChangesNothing() {
        on(Event.PAUSE, NONE, NOW);
        assertEquals(List.of(), watch.drawn());               // a background web view may not have shown it yet
        assertEquals(List.of(SEND_RESUME), on(Event.RESUME, NONE, NOW + 5));
        assertEquals(List.of(UNCOVER), watch.drawn());
    }

    @Test public void drawnDuringAHandOffThatHasNotLeftChangesNothing() {
        assertEquals(List.of(COVER), on(Event.PAUSE, FRESH, NOW));
        assertEquals(List.of(), watch.drawn());               // the cover stays up for the whole hand-off
        assertEquals(List.of(END_HAND_OFF, UNCOVER), on(Event.RESUME, FRESH, NOW + 20));
    }

    @Test public void aHandOffThatComesBackInTimeSendsNothing_andUncovers() {
        assertEquals(List.of(COVER), on(Event.PAUSE, FRESH, NOW));
        assertEquals(List.of(), on(Event.STOP, FRESH, NOW + 10));
        assertEquals(List.of(END_HAND_OFF, UNCOVER), on(Event.RESUME, FRESH, NOW + 20));
        assertEquals(List.of(), watch.drawn());
    }

    @Test public void aHandOffPastTheLimitLocksWhenTheTimerFires() {
        assertEquals(List.of(COVER), on(Event.PAUSE, FRESH, NOW));
        assertEquals(List.of(), on(Event.HAND_OFF_TIMER, FRESH, NOW));
        assertEquals(List.of(SEND_LEAVE), on(Event.HAND_OFF_TIMER, FRESH, FRESH + HAND_OFF_LIMIT_MS));
        assertEquals(List.of(END_HAND_OFF, SEND_RESUME), on(Event.RESUME, FRESH, FRESH + HAND_OFF_LIMIT_MS + 60_000));
    }

    @Test public void aHandOffPastTheLimitStillLocksOnReturn_whenTheTimerNeverRan() {
        assertEquals(List.of(COVER), on(Event.PAUSE, FRESH, NOW));
        assertEquals(List.of(SEND_LEAVE, END_HAND_OFF, SEND_RESUME), on(Event.RESUME, FRESH, FRESH + HAND_OFF_LIMIT_MS + 5));
    }

    @Test public void theScreenGoingOffDuringAHandOffLeaves() {
        assertEquals(List.of(COVER), on(Event.PAUSE, FRESH, NOW));
        assertEquals(List.of(SEND_LEAVE), on(Event.SCREEN_OFF, FRESH, NOW + 10));
    }

    @Test public void eachLeavingIsSentAgainAfterComingBack() {
        on(Event.PAUSE, NONE, NOW);
        on(Event.RESUME, NONE, NOW + 5);
        watch.drawn();
        assertEquals(List.of(COVER, SEND_LEAVE), on(Event.PAUSE, NONE, NOW + 10));
    }

    // a hand-off that ends after pause and stop have already been delivered (RF1)
    @Test public void aHandOffThatEndsWhileTheActivityIsStoppedLeaves_andTheCoverStaysUntilDrawn() {
        assertEquals(List.of(COVER), on(Event.PAUSE, FRESH, NOW));
        assertEquals(List.of(), on(Event.STOP, FRESH, NOW + 10));
        assertEquals(List.of(END_HAND_OFF, SEND_LEAVE), watch.handOffEnded(false));
        assertEquals(List.of(), watch.drawn());                 // still left: the cover stays
        assertEquals(List.of(SEND_RESUME), on(Event.RESUME, NONE, NOW + 30));
        assertEquals(List.of(UNCOVER), watch.drawn());
        assertEquals(List.of(), watch.drawn());
    }

    @Test public void aTimerArmedAtPauseStillLeavesAfterFiveMinutes_whenTheMarkWasClearedWithoutALeave() {
        assertEquals(List.of(COVER), on(Event.PAUSE, FRESH, NOW));
        assertEquals(List.of(), on(Event.STOP, FRESH, NOW + 10));
        assertEquals(List.of(SEND_LEAVE), on(Event.HAND_OFF_TIMER, NONE, FRESH + HAND_OFF_LIMIT_MS));
    }

    @Test public void aHandOffThatEndsWhileOnlyPausedStays_andComingBackDoesNotLeave() {
        assertEquals(List.of(COVER), on(Event.PAUSE, FRESH, NOW));
        assertEquals(List.of(END_HAND_OFF), watch.handOffEnded(true));
        assertEquals(List.of(UNCOVER), on(Event.RESUME, NONE, NOW + 20));
        assertEquals(List.of(), watch.drawn());
    }

    // save-as and the file picker: the activity was stopped, then started again before the screen closed
    @Test public void aSaveOrPickThatEndsOnceTheActivityIsStartedAgainDoesNotLeave() {
        assertEquals(List.of(COVER), on(Event.PAUSE, FRESH, NOW));
        assertEquals(List.of(), on(Event.STOP, FRESH, NOW + 10));
        assertEquals(List.of(END_HAND_OFF), watch.handOffEnded(true));
        assertEquals(List.of(UNCOVER), on(Event.RESUME, NONE, NOW + 20));
        assertEquals(List.of(), watch.drawn());
    }

    @Test public void aHandOffPastTheLimitStillLocksOnReturn_whenTheMarkWasClearedAndTheTimerNeverRan() {
        assertEquals(List.of(COVER), on(Event.PAUSE, FRESH, NOW));
        assertEquals(List.of(), on(Event.STOP, FRESH, NOW + 10));
        assertEquals(List.of(END_HAND_OFF), watch.handOffEnded(true));
        assertEquals(List.of(SEND_LEAVE, SEND_RESUME), on(Event.RESUME, NONE, FRESH + HAND_OFF_LIMIT_MS + 5));
    }
}
