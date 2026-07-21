package com.lycaonsolutions.t4code;

import org.junit.Test;

import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertThrows;
import static org.junit.Assert.assertTrue;

public final class T4QrPluginSessionTest {
    @Test
    public void permitsOnlyOneActiveAttempt() {
        T4QrPluginSession session = new T4QrPluginSession();

        assertTrue(session.start("scan-1"));
        assertFalse(session.start("scan-2"));
        assertEquals("scan-1", session.activeAttemptId());
    }

    @Test
    public void cancellationMustMatchTheActiveAttemptExactly() {
        T4QrPluginSession session = started("scan-1");

        assertNull(session.cancel("scan-2"));
        T4QrPluginSession.TerminalAction action = session.cancel("scan-1");

        assertEquals("scanClosed", action.eventName());
        assertEquals("scan-1", action.attemptId());
        assertEquals("cancelled", action.value());
        assertEquals(T4QrPluginSession.Settlement.RESOLVE, action.settlement());
    }

    @Test
    public void terminalActionEmitsBeforeSettlingAndReleasesOnlyAfterSettlement() {
        T4QrPluginSession session = started("scan-order");
        T4QrPluginSession.TerminalAction action = session.result("scan-order", "t4://invite");
        List<String> order = new ArrayList<>();

        session.settle(
            action,
            terminal -> {
                assertTrue(session.hasActiveAttempt());
                order.add("event:" + terminal.eventName());
            },
            terminal -> {
                assertTrue(session.hasActiveAttempt());
                order.add("call:" + terminal.settlement());
            }
        );

        assertEquals(List.of("event:scanResult", "call:RESOLVE"), order);
        assertFalse(session.hasActiveAttempt());
    }

    @Test
    public void concurrentSettlementOfTheSameActionEmitsAndSettlesExactlyOnce() throws Exception {
        T4QrPluginSession session = started("settle-race");
        T4QrPluginSession.TerminalAction action = session.cancel("settle-race");
        CountDownLatch firstEmitterEntered = new CountDownLatch(1);
        CountDownLatch releaseFirstEmitter = new CountDownLatch(1);
        AtomicInteger events = new AtomicInteger();
        AtomicInteger calls = new AtomicInteger();
        ExecutorService executor = Executors.newFixedThreadPool(2);
        try {
            Future<?> first = executor.submit(() -> session.settle(
                action,
                terminal -> {
                    events.incrementAndGet();
                    firstEmitterEntered.countDown();
                    await(releaseFirstEmitter);
                },
                terminal -> calls.incrementAndGet()
            ));
            assertTrue(firstEmitterEntered.await(2, TimeUnit.SECONDS));

            Future<?> duplicate = executor.submit(() -> session.settle(
                action,
                terminal -> events.incrementAndGet(),
                terminal -> calls.incrementAndGet()
            ));
            duplicate.get(2, TimeUnit.SECONDS);
            releaseFirstEmitter.countDown();
            first.get(2, TimeUnit.SECONDS);

            assertEquals(1, events.get());
            assertEquals(1, calls.get());
            assertFalse(session.hasActiveAttempt());
        } finally {
            releaseFirstEmitter.countDown();
            executor.shutdownNow();
            assertTrue(executor.awaitTermination(2, TimeUnit.SECONDS));
        }
    }

    @Test
    public void settlementFailureStillReleasesTheAttempt() {
        T4QrPluginSession session = started("scan-failure");
        T4QrPluginSession.TerminalAction action = session.error("scan-failure", "camera_unavailable");

        assertThrows(
            IllegalStateException.class,
            () -> session.settle(action, terminal -> {}, terminal -> {
                throw new IllegalStateException("bridge failed");
            })
        );

        assertFalse(session.hasActiveAttempt());
    }

    @Test
    public void settlementLinkageFailureStillReleasesTheAttempt() {
        T4QrPluginSession session = started("settlement-linkage-failure");
        T4QrPluginSession.TerminalAction action = session.error(
            "settlement-linkage-failure",
            "camera_unavailable"
        );

        assertThrows(
            LinkageError.class,
            () -> session.settle(action, terminal -> {}, terminal -> {
                throw new LinkageError("bridge linkage failed");
            })
        );

        assertFalse(session.hasActiveAttempt());
    }

    @Test
    public void eventFailureDoesNotPreventCallSettlementOrRelease() {
        T4QrPluginSession session = started("event-failure");
        T4QrPluginSession.TerminalAction action = session.cancel("event-failure");
        List<String> order = new ArrayList<>();

        assertThrows(
            IllegalStateException.class,
            () -> session.settle(
                action,
                terminal -> {
                    order.add("event");
                    throw new IllegalStateException("listener failed");
                },
                terminal -> order.add("call")
            )
        );

        assertEquals(List.of("event", "call"), order);
        assertFalse(session.hasActiveAttempt());
    }

    @Test
    public void eventLinkageFailureDoesNotPreventCallSettlementOrRelease() {
        T4QrPluginSession session = started("event-linkage-failure");
        T4QrPluginSession.TerminalAction action = session.cancel("event-linkage-failure");
        List<String> order = new ArrayList<>();

        assertThrows(
            LinkageError.class,
            () -> session.settle(
                action,
                terminal -> {
                    order.add("event");
                    throw new LinkageError("listener linkage failed");
                },
                terminal -> order.add("call")
            )
        );

        assertEquals(List.of("event", "call"), order);
        assertFalse(session.hasActiveAttempt());
    }

    @Test
    public void eventAndCallFailuresStillReleaseTheAttempt() {
        T4QrPluginSession session = started("both-fail");
        T4QrPluginSession.TerminalAction action = session.error("both-fail", "scanner_error");
        List<String> order = new ArrayList<>();

        assertThrows(
            IllegalStateException.class,
            () -> session.settle(
                action,
                terminal -> {
                    order.add("event");
                    throw new LinkageError("listener linkage failed");
                },
                terminal -> {
                    order.add("call");
                    throw new IllegalStateException("bridge failed");
                }
            )
        );

        assertEquals(List.of("event", "call"), order);
        assertFalse(session.hasActiveAttempt());
    }

    @Test
    public void resultCancelAndErrorRaceProducesExactlyOneTerminalAction() throws Exception {
        ExecutorService executor = Executors.newFixedThreadPool(3);
        try {
            for (int iteration = 0; iteration < 250; iteration += 1) {
                T4QrPluginSession session = started("race-" + iteration);
                CountDownLatch ready = new CountDownLatch(3);
                CountDownLatch start = new CountDownLatch(1);

                Future<T4QrPluginSession.TerminalAction> result = executor.submit(
                    () -> race(ready, start, () -> session.result(session.activeAttemptId(), "value"))
                );
                Future<T4QrPluginSession.TerminalAction> cancel = executor.submit(
                    () -> race(ready, start, () -> session.cancel(session.activeAttemptId()))
                );
                Future<T4QrPluginSession.TerminalAction> error = executor.submit(
                    () -> race(ready, start, () -> session.error(session.activeAttemptId(), "failed"))
                );

                assertTrue(ready.await(2, TimeUnit.SECONDS));
                start.countDown();
                int winners = count(result.get(2, TimeUnit.SECONDS))
                    + count(cancel.get(2, TimeUnit.SECONDS))
                    + count(error.get(2, TimeUnit.SECONDS));
                assertEquals("iteration " + iteration, 1, winners);
            }
        } finally {
            executor.shutdownNow();
            assertTrue(executor.awaitTermination(2, TimeUnit.SECONDS));
        }
    }

    @Test
    public void duplicateCallbacksAreIdempotent() {
        T4QrPluginSession session = started("duplicates");

        T4QrPluginSession.TerminalAction first = session.error("duplicates", "scanner_error");

        assertNull(session.error("duplicates", "scanner_error"));
        assertNull(session.cancel("duplicates"));
        assertNull(session.result("duplicates", "value"));
        session.settle(first, terminal -> {}, terminal -> {});
        assertNull(session.error("duplicates", "scanner_error"));
    }

    @Test
    public void resultValidatesTheReturnedAttemptAndPayload() {
        T4QrPluginSession session = started("scan-1");

        assertThrows(IllegalArgumentException.class, () -> session.result("scan-2", "value"));
        assertThrows(IllegalArgumentException.class, () -> session.result("scan-1", ""));
        assertTrue(session.hasActiveAttempt());
    }

    private static T4QrPluginSession started(String attemptId) {
        T4QrPluginSession session = new T4QrPluginSession();
        assertTrue(session.start(attemptId));
        return session;
    }

    private static T4QrPluginSession.TerminalAction race(
        CountDownLatch ready,
        CountDownLatch start,
        Action action
    ) throws Exception {
        ready.countDown();
        assertTrue(start.await(2, TimeUnit.SECONDS));
        return action.run();
    }

    private static int count(T4QrPluginSession.TerminalAction action) {
        return action == null ? 0 : 1;
    }

    private static void await(CountDownLatch latch) {
        try {
            if (!latch.await(2, TimeUnit.SECONDS)) {
                throw new AssertionError("Timed out waiting for settlement race");
            }
        } catch (InterruptedException error) {
            Thread.currentThread().interrupt();
            throw new AssertionError("Interrupted while waiting for settlement race", error);
        }
    }

    private interface Action {
        T4QrPluginSession.TerminalAction run();
    }
}
