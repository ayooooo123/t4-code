package com.lycaonsolutions.t4code;

import java.util.concurrent.Executor;
import java.util.concurrent.atomic.AtomicReference;

/** First-wins terminal arbitration that always dispatches work through the UI executor. */
final class T4QrTerminalCoordinator {
    private final Executor mainExecutor;
    private final Object schedulingMonitor = new Object();
    private Claim active;

    T4QrTerminalCoordinator(Executor mainExecutor) {
        if (mainExecutor == null) {
            throw new IllegalArgumentException("mainExecutor is required");
        }
        this.mainExecutor = mainExecutor;
    }

    boolean request(Runnable terminalAction) {
        if (terminalAction == null) {
            throw new IllegalArgumentException("terminalAction is required");
        }
        Claim claim;
        boolean interrupted = false;
        synchronized (schedulingMonitor) {
            while (active != null && active.isTentative()) {
                try {
                    schedulingMonitor.wait();
                } catch (InterruptedException ignored) {
                    interrupted = true;
                }
            }
            if (active != null) {
                restoreInterrupt(interrupted);
                return false;
            }
            claim = new Claim(terminalAction);
            active = claim;
        }
        try {
            mainExecutor.execute(claim::runIfScheduled);
            acceptScheduling(claim);
            restoreInterrupt(interrupted);
            return true;
        } catch (RuntimeException | LinkageError ignored) {
            boolean accepted = rejectScheduling(claim);
            restoreInterrupt(interrupted);
            return accepted;
        }
    }

    boolean isRequested() {
        synchronized (schedulingMonitor) {
            return active != null;
        }
    }

    private void acceptScheduling(Claim claim) {
        synchronized (schedulingMonitor) {
            claim.resolveScheduling();
            schedulingMonitor.notifyAll();
        }
    }

    private boolean rejectScheduling(Claim claim) {
        synchronized (schedulingMonitor) {
            boolean cancelled = claim.cancelBeforeRun();
            claim.resolveScheduling();
            if (cancelled && active == claim) {
                active = null;
            }
            schedulingMonitor.notifyAll();
            return !cancelled;
        }
    }

    private static void restoreInterrupt(boolean interrupted) {
        if (interrupted) {
            Thread.currentThread().interrupt();
        }
    }

    private static final class Claim {
        private enum Phase {
            SCHEDULED,
            RUNNING,
            FINISHED,
            CANCELLED
        }

        private final Runnable action;
        private final AtomicReference<Phase> phase = new AtomicReference<>(Phase.SCHEDULED);
        private volatile boolean schedulingResolved;

        private Claim(Runnable action) {
            this.action = action;
        }

        private boolean cancelBeforeRun() {
            return phase.compareAndSet(Phase.SCHEDULED, Phase.CANCELLED);
        }

        private boolean isTentative() {
            return !schedulingResolved && phase.get() == Phase.SCHEDULED;
        }

        private void resolveScheduling() {
            schedulingResolved = true;
        }

        private void runIfScheduled() {
            if (!phase.compareAndSet(Phase.SCHEDULED, Phase.RUNNING)) {
                return;
            }
            try {
                action.run();
            } catch (RuntimeException | LinkageError ignored) {
                // Terminal work owns the outcome once it begins; never expose failure details.
            } finally {
                phase.set(Phase.FINISHED);
            }
        }
    }
}
