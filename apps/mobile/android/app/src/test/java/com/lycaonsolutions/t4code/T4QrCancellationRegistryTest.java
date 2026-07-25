package com.lycaonsolutions.t4code;

import org.junit.Test;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

public final class T4QrCancellationRegistryTest {
    @Test
    public void cancelBeforeActivityRegistrationIsConsumedOnce() {
        T4QrCancellationRegistry registry = new T4QrCancellationRegistry(4);

        registry.record("scan-1");

        assertTrue(registry.consume("scan-1"));
        assertFalse(registry.consume("scan-1"));
    }

    @Test
    public void mismatchedAttemptsRemainIsolated() {
        T4QrCancellationRegistry registry = new T4QrCancellationRegistry(4);
        registry.record("scan-1");

        assertFalse(registry.consume("scan-2"));
        assertTrue(registry.consume("scan-1"));
    }

    @Test
    public void cleanupRemovesOnlyTheMatchingAttempt() {
        T4QrCancellationRegistry registry = new T4QrCancellationRegistry(4);
        registry.record("scan-1");
        registry.record("scan-2");

        registry.remove("scan-1");

        assertFalse(registry.consume("scan-1"));
        assertTrue(registry.consume("scan-2"));
    }

    @Test
    public void registryIsBoundedToRecentCancellationIds() {
        T4QrCancellationRegistry registry = new T4QrCancellationRegistry(2);
        registry.record("scan-1");
        registry.record("scan-2");
        registry.record("scan-3");

        assertFalse(registry.consume("scan-1"));
        assertTrue(registry.consume("scan-2"));
        assertTrue(registry.consume("scan-3"));
    }

    @Test
    public void duplicateCancellationDoesNotEvictAnotherAttempt() {
        T4QrCancellationRegistry registry = new T4QrCancellationRegistry(2);
        registry.record("scan-1");
        registry.record("scan-2");
        registry.record("scan-1");

        assertTrue(registry.consume("scan-1"));
        assertTrue(registry.consume("scan-2"));
    }

    @Test
    public void configurationTeardownPreservesCancellationForTheRecreatedActivity() {
        T4QrCancellationRegistry registry = new T4QrCancellationRegistry(4);
        registry.record("rotate-me");

        registry.cleanup("rotate-me", true);

        assertTrue(registry.consume("rotate-me"));
    }

    @Test
    public void terminalOrNonConfigurationTeardownRemovesCancellation() {
        T4QrCancellationRegistry registry = new T4QrCancellationRegistry(4);
        registry.record("finished");

        registry.cleanup("finished", false);

        assertFalse(registry.consume("finished"));
    }
}
