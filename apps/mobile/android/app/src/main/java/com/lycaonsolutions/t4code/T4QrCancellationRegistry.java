package com.lycaonsolutions.t4code;

import java.util.Iterator;
import java.util.LinkedHashSet;
import java.util.Set;

/** Bounded process-local cancellation IDs; never stores an Activity, plugin, or bridge call. */
final class T4QrCancellationRegistry {
    private static final int DEFAULT_CAPACITY = 32;
    private static final T4QrCancellationRegistry SHARED =
        new T4QrCancellationRegistry(DEFAULT_CAPACITY);

    private final int capacity;
    private final Set<String> cancelledAttemptIds = new LinkedHashSet<>();

    T4QrCancellationRegistry(int capacity) {
        if (capacity < 1) {
            throw new IllegalArgumentException("Cancellation registry must have positive capacity");
        }
        this.capacity = capacity;
    }

    static T4QrCancellationRegistry shared() {
        return SHARED;
    }

    synchronized void record(String attemptId) {
        String validAttemptId = T4QrPayload.requireAttemptId(attemptId);
        if (cancelledAttemptIds.contains(validAttemptId)) {
            return;
        }
        while (cancelledAttemptIds.size() >= capacity) {
            Iterator<String> oldest = cancelledAttemptIds.iterator();
            oldest.next();
            oldest.remove();
        }
        cancelledAttemptIds.add(validAttemptId);
    }

    synchronized boolean consume(String attemptId) {
        return cancelledAttemptIds.remove(T4QrPayload.requireAttemptId(attemptId));
    }

    synchronized void remove(String attemptId) {
        cancelledAttemptIds.remove(T4QrPayload.requireAttemptId(attemptId));
    }

    synchronized void cleanup(String attemptId, boolean changingConfigurations) {
        String validAttemptId = T4QrPayload.requireAttemptId(attemptId);
        if (!changingConfigurations) {
            cancelledAttemptIds.remove(validAttemptId);
        }
    }
}
