package com.lycaonsolutions.t4code;

import java.util.concurrent.atomic.AtomicBoolean;

/** Runs every teardown action at most once, isolating failures between resources. */
final class T4QrCleanup {
    private final AtomicBoolean started = new AtomicBoolean(false);

    boolean run(Runnable... actions) {
        if (!started.compareAndSet(false, true)) {
            return false;
        }
        for (Runnable action : actions) {
            if (action == null) {
                continue;
            }
            try {
                action.run();
            } catch (RuntimeException | LinkageError ignored) {
                // Cleanup is best-effort and exception details are never surfaced.
            }
        }
        return true;
    }

    boolean isStarted() {
        return started.get();
    }
}
