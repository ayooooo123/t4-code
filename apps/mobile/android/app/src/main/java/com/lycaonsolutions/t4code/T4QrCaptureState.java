package com.lycaonsolutions.t4code;

/** Activity-owned lifecycle for one QR capture attempt. */
public final class T4QrCaptureState {
    public enum Phase {
        STARTING,
        SCANNING,
        RESULT,
        CANCELLED,
        FAILED
    }

    private final String attemptId;
    private Phase phase = Phase.STARTING;

    public T4QrCaptureState(String attemptId) {
        if (!isValidAttemptId(attemptId)) {
            throw new IllegalArgumentException("attemptId must be a non-empty ASCII token of at most 128 characters");
        }
        this.attemptId = attemptId;
    }

    public String attemptId() {
        return attemptId;
    }

    public synchronized Phase phase() {
        return phase;
    }

    public synchronized boolean started() {
        if (phase != Phase.STARTING) {
            return false;
        }
        phase = Phase.SCANNING;
        return true;
    }

    public synchronized boolean result() {
        return finish(Phase.RESULT);
    }

    public synchronized boolean cancelled() {
        return finish(Phase.CANCELLED);
    }

    public synchronized boolean failed() {
        return finish(Phase.FAILED);
    }

    private boolean finish(Phase terminalPhase) {
        if (phase != Phase.SCANNING) {
            return false;
        }
        phase = terminalPhase;
        return true;
    }

    private static boolean isValidAttemptId(String attemptId) {
        if (attemptId == null || attemptId.isEmpty() || attemptId.length() > 128) {
            return false;
        }
        for (int index = 0; index < attemptId.length(); index += 1) {
            char character = attemptId.charAt(index);
            if (character < 0x21 || character > 0x7e) {
                return false;
            }
        }
        return true;
    }
}
