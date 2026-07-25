package com.lycaonsolutions.t4code;

import java.util.Objects;
import java.util.function.Consumer;

/** Owns the single in-flight QR plugin attempt without retaining a Capacitor call. */
final class T4QrPluginSession {
    private enum TerminalState {
        IDLE,
        CLAIMED,
        SETTLING
    }

    enum Settlement {
        RESOLVE,
        REJECT
    }

    static final class TerminalAction {
        private final String eventName;
        private final String attemptId;
        private final String value;
        private final Settlement settlement;

        private TerminalAction(
            String eventName,
            String attemptId,
            String value,
            Settlement settlement
        ) {
            this.eventName = eventName;
            this.attemptId = attemptId;
            this.value = value;
            this.settlement = settlement;
        }

        String eventName() {
            return eventName;
        }

        String attemptId() {
            return attemptId;
        }

        String value() {
            return value;
        }

        Settlement settlement() {
            return settlement;
        }
    }

    private String activeAttemptId;
    private TerminalAction terminalAction;
    private TerminalState terminalState = TerminalState.IDLE;

    synchronized boolean start(String attemptId) {
        String validAttemptId = T4QrPayload.requireAttemptId(attemptId);
        if (activeAttemptId != null) {
            return false;
        }
        activeAttemptId = validAttemptId;
        terminalAction = null;
        terminalState = TerminalState.IDLE;
        return true;
    }

    synchronized String activeAttemptId() {
        return activeAttemptId;
    }

    synchronized boolean hasActiveAttempt() {
        return activeAttemptId != null;
    }

    TerminalAction result(String returnedAttemptId, String rawValue) {
        String expectedAttemptId;
        synchronized (this) {
            expectedAttemptId = activeAttemptId;
        }
        T4QrPayload payload = T4QrPayload.validate(
            expectedAttemptId,
            returnedAttemptId,
            rawValue
        );
        return claim("scanResult", payload.attemptId(), payload.rawValue(), Settlement.RESOLVE);
    }

    TerminalAction cancel(String attemptId) {
        String validAttemptId = T4QrPayload.requireAttemptId(attemptId);
        return claim("scanClosed", validAttemptId, "cancelled", Settlement.RESOLVE);
    }

    TerminalAction closed(String attemptId, String reason) {
        String validAttemptId = T4QrPayload.requireAttemptId(attemptId);
        return claim("scanClosed", validAttemptId, requireValue(reason), Settlement.RESOLVE);
    }

    TerminalAction error(String attemptId, String code) {
        String validAttemptId = T4QrPayload.requireAttemptId(attemptId);
        return claim("scanError", validAttemptId, requireValue(code), Settlement.REJECT);
    }

    void settle(
        TerminalAction action,
        Consumer<TerminalAction> eventEmitter,
        Consumer<TerminalAction> callSettler
    ) {
        Objects.requireNonNull(action, "action");
        Objects.requireNonNull(eventEmitter, "eventEmitter");
        Objects.requireNonNull(callSettler, "callSettler");
        synchronized (this) {
            if (terminalAction != action || terminalState != TerminalState.CLAIMED) {
                return;
            }
            terminalState = TerminalState.SETTLING;
        }
        Throwable eventFailure = null;
        try {
            try {
                eventEmitter.accept(action);
            } catch (RuntimeException | LinkageError error) {
                eventFailure = error;
            }
            callSettler.accept(action);
            if (eventFailure instanceof RuntimeException runtimeException) {
                throw runtimeException;
            }
            if (eventFailure instanceof LinkageError linkageError) {
                throw linkageError;
            }
        } finally {
            synchronized (this) {
                if (terminalAction == action) {
                    terminalAction = null;
                    activeAttemptId = null;
                    terminalState = TerminalState.IDLE;
                }
            }
        }
    }

    private synchronized TerminalAction claim(
        String eventName,
        String attemptId,
        String value,
        Settlement settlement
    ) {
        if (!attemptId.equals(activeAttemptId) || terminalState != TerminalState.IDLE) {
            return null;
        }
        terminalAction = new TerminalAction(eventName, attemptId, value, settlement);
        terminalState = TerminalState.CLAIMED;
        return terminalAction;
    }

    private static String requireValue(String value) {
        if (value == null || value.isEmpty()) {
            throw new IllegalArgumentException("Invalid QR scanner terminal value");
        }
        return value;
    }
}
