package com.lycaonsolutions.t4code;

import java.util.concurrent.atomic.AtomicBoolean;

/** Owns one accepted ImageProxy until completion or synchronous/async failure. */
final class T4QrFrameSettlement {
    private final Runnable closeFrame;
    private final T4QrTerminalCoordinator terminal;
    private final Runnable terminalFailure;
    private final AtomicBoolean closed = new AtomicBoolean(false);

    T4QrFrameSettlement(
        Runnable closeFrame,
        T4QrTerminalCoordinator terminal,
        Runnable terminalFailure
    ) {
        if (closeFrame == null || terminal == null || terminalFailure == null) {
            throw new IllegalArgumentException("Frame settlement collaborators are required");
        }
        this.closeFrame = closeFrame;
        this.terminal = terminal;
        this.terminalFailure = terminalFailure;
    }

    void completed() {
        closeOnce();
    }

    void failed() {
        closeOnce();
        terminal.request(terminalFailure);
    }

    private void closeOnce() {
        if (!closed.compareAndSet(false, true)) {
            return;
        }
        try {
            closeFrame.run();
        } catch (RuntimeException | LinkageError ignored) {
            // A broken camera resource must not expose details or win a terminal race.
        }
    }
}
