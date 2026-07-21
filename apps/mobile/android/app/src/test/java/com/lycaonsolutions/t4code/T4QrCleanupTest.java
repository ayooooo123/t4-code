package com.lycaonsolutions.t4code;

import org.junit.Test;

import java.util.concurrent.atomic.AtomicInteger;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

public final class T4QrCleanupTest {
    @Test
    public void everyCleanupRunsWhenEarlierCleanupThrowsAndTheSequenceIsIdempotent() {
        T4QrCleanup cleanup = new T4QrCleanup();
        AtomicInteger first = new AtomicInteger();
        AtomicInteger second = new AtomicInteger();
        AtomicInteger third = new AtomicInteger();

        assertTrue(cleanup.run(
            () -> {
                first.incrementAndGet();
                throw new IllegalStateException("private failure text");
            },
            second::incrementAndGet,
            () -> {
                third.incrementAndGet();
                throw new LinkageError("private linkage text");
            }
        ));
        assertFalse(
            cleanup.run(first::incrementAndGet, second::incrementAndGet, third::incrementAndGet)
        );

        assertEquals(1, first.get());
        assertEquals(1, second.get());
        assertEquals(1, third.get());
    }
}
