package com.lycaonsolutions.t4code;

import org.junit.Test;

import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import java.util.concurrent.atomic.AtomicInteger;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertThrows;
import static org.junit.Assert.assertTrue;

public final class T4QrTerminalCoordinatorTest {
    @Test
    public void terminalWorkIsMarshalledThroughTheConfiguredMainExecutor() {
        QueuedExecutor main = new QueuedExecutor();
        T4QrTerminalCoordinator terminal = new T4QrTerminalCoordinator(main);
        AtomicInteger finishes = new AtomicInteger();

        assertTrue(terminal.request(finishes::incrementAndGet));
        assertTrue(terminal.isRequested());
        assertEquals(0, finishes.get());

        main.runAll();
        assertEquals(1, finishes.get());
    }

    @Test
    public void successAndCancellationRaceSettlesExactlyOnce() throws Exception {
        QueuedExecutor main = new QueuedExecutor();
        T4QrTerminalCoordinator terminal = new T4QrTerminalCoordinator(main);
        AtomicInteger finishes = new AtomicInteger();
        ExecutorService racers = Executors.newFixedThreadPool(2);
        CountDownLatch ready = new CountDownLatch(2);
        CountDownLatch start = new CountDownLatch(1);
        try {
            Future<Boolean> success = racers.submit(
                () -> raceRequest(ready, start, terminal, finishes::incrementAndGet)
            );
            Future<Boolean> cancel = racers.submit(
                () -> raceRequest(ready, start, terminal, finishes::incrementAndGet)
            );
            assertTrue(ready.await(2, TimeUnit.SECONDS));
            start.countDown();

            int accepted = (success.get(2, TimeUnit.SECONDS) ? 1 : 0)
                + (cancel.get(2, TimeUnit.SECONDS) ? 1 : 0);
            assertEquals(1, accepted);
            main.runAll();
            assertEquals(1, finishes.get());
            assertFalse(terminal.request(finishes::incrementAndGet));
        } finally {
            racers.shutdownNow();
        }
    }

    @Test
    public void rejectedSchedulingRollsBackSoALaterTerminalRequestCanWin() {
        AtomicInteger schedules = new AtomicInteger();
        T4QrTerminalCoordinator terminal = new T4QrTerminalCoordinator(command -> {
            if (schedules.getAndIncrement() == 0) {
                throw new RejectedExecutionException("private executor text");
            }
            command.run();
        });
        AtomicInteger finishes = new AtomicInteger();

        assertFalse(terminal.request(() -> finishes.addAndGet(100)));
        assertFalse(terminal.isRequested());
        assertTrue(terminal.request(finishes::incrementAndGet));
        assertTrue(terminal.isRequested());
        assertEquals(1, finishes.get());
    }

    @Test
    public void queuedThenThrowingExecutorCannotRunARejectedStaleAction() {
        List<Runnable> stale = new ArrayList<>();
        AtomicInteger schedules = new AtomicInteger();
        T4QrTerminalCoordinator terminal = new T4QrTerminalCoordinator(command -> {
            if (schedules.getAndIncrement() == 0) {
                stale.add(command);
                throw new IllegalStateException("private executor text");
            }
            command.run();
        });
        AtomicInteger rejectedAction = new AtomicInteger();
        AtomicInteger acceptedAction = new AtomicInteger();

        assertFalse(terminal.request(rejectedAction::incrementAndGet));
        assertTrue(terminal.request(acceptedAction::incrementAndGet));
        stale.forEach(Runnable::run);

        assertEquals(0, rejectedAction.get());
        assertEquals(1, acceptedAction.get());
    }

    @Test
    public void throwingTerminalActionIsContainedAndRetainsFirstWinsOwnership() {
        QueuedExecutor main = new QueuedExecutor();
        T4QrTerminalCoordinator terminal = new T4QrTerminalCoordinator(main);
        AtomicInteger starts = new AtomicInteger();

        assertTrue(terminal.request(() -> {
            starts.incrementAndGet();
            throw new IllegalStateException("private action text");
        }));
        main.runAll();

        assertEquals(1, starts.get());
        assertTrue(terminal.isRequested());
        assertFalse(terminal.request(starts::incrementAndGet));
        assertEquals(1, starts.get());
    }

    @Test
    public void concurrentRequestWaitsForTentativeSchedulingThenWinsAfterRejection() throws Exception {
        CountDownLatch firstScheduling = new CountDownLatch(1);
        CountDownLatch rejectFirst = new CountDownLatch(1);
        AtomicInteger schedules = new AtomicInteger();
        T4QrTerminalCoordinator terminal = new T4QrTerminalCoordinator(command -> {
            if (schedules.getAndIncrement() == 0) {
                firstScheduling.countDown();
                try {
                    assertTrue(rejectFirst.await(2, TimeUnit.SECONDS));
                } catch (InterruptedException error) {
                    Thread.currentThread().interrupt();
                    throw new RejectedExecutionException();
                }
                throw new RejectedExecutionException("private executor text");
            }
            command.run();
        });
        AtomicInteger firstAction = new AtomicInteger();
        AtomicInteger secondAction = new AtomicInteger();
        ExecutorService callers = Executors.newFixedThreadPool(2);
        try {
            Future<Boolean> first = callers.submit(() -> terminal.request(firstAction::incrementAndGet));
            assertTrue(firstScheduling.await(2, TimeUnit.SECONDS));
            Future<Boolean> second = callers.submit(
                () -> terminal.request(secondAction::incrementAndGet)
            );

            assertThrows(TimeoutException.class, () -> second.get(100, TimeUnit.MILLISECONDS));
            rejectFirst.countDown();

            assertFalse(first.get(2, TimeUnit.SECONDS));
            assertTrue(second.get(2, TimeUnit.SECONDS));
            assertEquals(0, firstAction.get());
            assertEquals(1, secondAction.get());
            assertTrue(terminal.isRequested());
        } finally {
            rejectFirst.countDown();
            callers.shutdownNow();
            assertTrue(callers.awaitTermination(2, TimeUnit.SECONDS));
        }
    }

    private static boolean raceRequest(
        CountDownLatch ready,
        CountDownLatch start,
        T4QrTerminalCoordinator terminal,
        Runnable action
    ) throws InterruptedException {
        ready.countDown();
        assertTrue(start.await(2, TimeUnit.SECONDS));
        return terminal.request(action);
    }

    static final class QueuedExecutor implements java.util.concurrent.Executor {
        private final List<Runnable> tasks = new ArrayList<>();

        @Override
        public synchronized void execute(Runnable command) {
            tasks.add(command);
        }

        synchronized void runAll() {
            List<Runnable> pending = new ArrayList<>(tasks);
            tasks.clear();
            pending.forEach(Runnable::run);
        }
    }
}
