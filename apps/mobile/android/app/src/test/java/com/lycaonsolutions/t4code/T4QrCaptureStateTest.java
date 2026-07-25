package com.lycaonsolutions.t4code;

import org.junit.Test;

import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertThrows;
import static org.junit.Assert.assertTrue;

public final class T4QrCaptureStateTest {
    @Test
    public void captureMovesFromStartingToScanningToResult() {
        T4QrCaptureState state = new T4QrCaptureState("scan-1");

        assertEquals("scan-1", state.attemptId());
        assertEquals(T4QrCaptureState.Phase.STARTING, state.phase());
        assertTrue(state.started());
        assertEquals(T4QrCaptureState.Phase.SCANNING, state.phase());
        assertTrue(state.result());
        assertEquals(T4QrCaptureState.Phase.RESULT, state.phase());
    }

    @Test
    public void captureCanFinishCancelled() {
        T4QrCaptureState state = scanningState("cancelled");

        assertTrue(state.cancelled());
        assertEquals(T4QrCaptureState.Phase.CANCELLED, state.phase());
    }

    @Test
    public void captureCanFinishFailed() {
        T4QrCaptureState state = scanningState("failed");

        assertTrue(state.failed());
        assertEquals(T4QrCaptureState.Phase.FAILED, state.phase());
    }

    @Test
    public void firstTerminalResultWinsAndDuplicatesAreIgnored() {
        T4QrCaptureState state = scanningState("first-wins");

        assertTrue(state.result());
        assertFalse(state.result());
        assertFalse(state.cancelled());
        assertFalse(state.failed());
        assertEquals(T4QrCaptureState.Phase.RESULT, state.phase());
    }

    @Test
    public void cancelledCaptureRejectsLateAnalyzerCompletion() {
        T4QrCaptureState state = scanningState("cancel-race");

        assertTrue(state.cancelled());
        assertFalse(state.result());
        assertFalse(state.failed());
        assertEquals(T4QrCaptureState.Phase.CANCELLED, state.phase());
    }

    @Test
    public void concurrentTerminalCallbacksProduceExactlyOneMatchingWinner() throws Exception {
        ExecutorService executor = Executors.newFixedThreadPool(3);
        try {
            for (int iteration = 0; iteration < 250; iteration += 1) {
                T4QrCaptureState state = scanningState("race-" + iteration);
                CountDownLatch ready = new CountDownLatch(3);
                CountDownLatch start = new CountDownLatch(1);

                Future<Boolean> result = executor.submit(() -> raceTransition(ready, start, state::result));
                Future<Boolean> cancelled = executor.submit(() -> raceTransition(ready, start, state::cancelled));
                Future<Boolean> failed = executor.submit(() -> raceTransition(ready, start, state::failed));

                assertTrue("workers did not become ready", ready.await(2, TimeUnit.SECONDS));
                start.countDown();

                boolean resultWon = result.get(2, TimeUnit.SECONDS);
                boolean cancelledWon = cancelled.get(2, TimeUnit.SECONDS);
                boolean failedWon = failed.get(2, TimeUnit.SECONDS);
                int winners = (resultWon ? 1 : 0) + (cancelledWon ? 1 : 0) + (failedWon ? 1 : 0);

                assertEquals("iteration " + iteration, 1, winners);
                T4QrCaptureState.Phase expected = resultWon
                    ? T4QrCaptureState.Phase.RESULT
                    : cancelledWon ? T4QrCaptureState.Phase.CANCELLED : T4QrCaptureState.Phase.FAILED;
                assertEquals("iteration " + iteration, expected, state.phase());
            }
        } finally {
            executor.shutdownNow();
            assertTrue("executor did not terminate", executor.awaitTermination(2, TimeUnit.SECONDS));
        }
    }

    @Test
    public void startingTransitionOnlySucceedsOnce() {
        T4QrCaptureState state = new T4QrCaptureState("single-start");

        assertTrue(state.started());
        assertFalse(state.started());
        assertEquals(T4QrCaptureState.Phase.SCANNING, state.phase());
    }

    @Test
    public void attemptIdMustBeANonEmptyAsciiTokenNoLongerThan128Characters() {
        assertThrows(IllegalArgumentException.class, () -> new T4QrCaptureState(null));
        assertThrows(IllegalArgumentException.class, () -> new T4QrCaptureState(""));
        assertThrows(IllegalArgumentException.class, () -> new T4QrCaptureState("has space"));
        assertThrows(IllegalArgumentException.class, () -> new T4QrCaptureState("scan-é"));
        assertThrows(IllegalArgumentException.class, () -> new T4QrCaptureState("\u001f"));
        assertThrows(IllegalArgumentException.class, () -> new T4QrCaptureState("\u007f"));
        assertThrows(IllegalArgumentException.class, () -> new T4QrCaptureState(repeat('a', 129)));

        assertEquals("!", new T4QrCaptureState("!").attemptId());
        assertEquals("~", new T4QrCaptureState("~").attemptId());
        assertEquals(repeat('a', 128), new T4QrCaptureState(repeat('a', 128)).attemptId());
    }

    private static boolean raceTransition(
        CountDownLatch ready,
        CountDownLatch start,
        Transition transition
    ) throws InterruptedException {
        ready.countDown();
        assertTrue("race did not start", start.await(2, TimeUnit.SECONDS));
        return transition.run();
    }

    private interface Transition {
        boolean run();
    }

    private static T4QrCaptureState scanningState(String attemptId) {
        T4QrCaptureState state = new T4QrCaptureState(attemptId);
        assertTrue(state.started());
        return state;
    }

    private static String repeat(char value, int count) {
        StringBuilder builder = new StringBuilder(count);
        for (int index = 0; index < count; index += 1) {
            builder.append(value);
        }
        return builder.toString();
    }
}
