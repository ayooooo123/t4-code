package com.lycaonsolutions.t4code;

import org.junit.Test;

import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

public final class T4QrFrameSettlementTest {
    @Test
    public void synchronousProcessOrListenerRegistrationFailureClosesExactlyOnce() {
        T4QrTerminalCoordinatorTest.QueuedExecutor main =
            new T4QrTerminalCoordinatorTest.QueuedExecutor();
        T4QrTerminalCoordinator terminal = new T4QrTerminalCoordinator(main);
        AtomicInteger closes = new AtomicInteger();
        AtomicInteger failures = new AtomicInteger();
        T4QrFrameSettlement frame = new T4QrFrameSettlement(
            closes::incrementAndGet,
            terminal,
            failures::incrementAndGet
        );

        frame.failed();
        frame.completed();
        frame.failed();
        main.runAll();

        assertEquals(1, closes.get());
        assertEquals(1, failures.get());
    }

    @Test
    public void asynchronousFailureClosesExactlyOnceAndRequestsTerminalFailure() {
        T4QrTerminalCoordinatorTest.QueuedExecutor main =
            new T4QrTerminalCoordinatorTest.QueuedExecutor();
        T4QrTerminalCoordinator terminal = new T4QrTerminalCoordinator(main);
        AtomicInteger closes = new AtomicInteger();
        AtomicInteger failures = new AtomicInteger();
        T4QrFrameSettlement frame = new T4QrFrameSettlement(
            closes::incrementAndGet,
            terminal,
            failures::incrementAndGet
        );

        frame.failed();
        frame.completed();
        main.runAll();

        assertEquals(1, closes.get());
        assertEquals(1, failures.get());
        assertTrue(terminal.isRequested());
    }

    @Test
    public void successCompletionAndCancellationRaceProducesOneTerminalOutcome() throws Exception {
        T4QrTerminalCoordinatorTest.QueuedExecutor main =
            new T4QrTerminalCoordinatorTest.QueuedExecutor();
        T4QrTerminalCoordinator terminal = new T4QrTerminalCoordinator(main);
        AtomicInteger closes = new AtomicInteger();
        AtomicInteger outcomes = new AtomicInteger();
        T4QrFrameSettlement frame = new T4QrFrameSettlement(
            closes::incrementAndGet,
            terminal,
            outcomes::incrementAndGet
        );

        ExecutorService racers = Executors.newFixedThreadPool(3);
        CountDownLatch ready = new CountDownLatch(3);
        CountDownLatch start = new CountDownLatch(1);
        try {
            Future<Boolean> success = racers.submit(
                () -> raceTerminal(ready, start, terminal, outcomes)
            );
            Future<Boolean> cancel = racers.submit(
                () -> raceTerminal(ready, start, terminal, outcomes)
            );
            Future<?> completion = racers.submit(() -> {
                ready.countDown();
                assertTrue(start.await(2, TimeUnit.SECONDS));
                frame.completed();
                return null;
            });
            assertTrue(ready.await(2, TimeUnit.SECONDS));
            start.countDown();

            int accepted = (success.get(2, TimeUnit.SECONDS) ? 1 : 0)
                + (cancel.get(2, TimeUnit.SECONDS) ? 1 : 0);
            completion.get(2, TimeUnit.SECONDS);
            main.runAll();

            assertEquals(1, accepted);
            assertEquals(1, closes.get());
            assertEquals(1, outcomes.get());
        } finally {
            racers.shutdownNow();
        }
    }

    private static boolean raceTerminal(
        CountDownLatch ready,
        CountDownLatch start,
        T4QrTerminalCoordinator terminal,
        AtomicInteger outcomes
    ) throws InterruptedException {
        ready.countDown();
        assertTrue(start.await(2, TimeUnit.SECONDS));
        return terminal.request(outcomes::incrementAndGet);
    }
}
