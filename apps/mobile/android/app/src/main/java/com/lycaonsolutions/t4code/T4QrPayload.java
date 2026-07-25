package com.lycaonsolutions.t4code;

import java.nio.charset.StandardCharsets;

/** Validated, attempt-scoped scanner result with no Android dependencies. */
public final class T4QrPayload {
    public static final int MAX_ATTEMPT_ID_LENGTH = 128;
    public static final int MAX_RAW_VALUE_BYTES = 2_048;

    private final String attemptId;
    private final String rawValue;

    private T4QrPayload(String attemptId, String rawValue) {
        this.attemptId = attemptId;
        this.rawValue = rawValue;
    }

    public static T4QrPayload validate(
        String expectedAttemptId,
        String returnedAttemptId,
        String rawValue
    ) {
        requireAttemptId(expectedAttemptId);
        requireAttemptId(returnedAttemptId);
        if (!expectedAttemptId.equals(returnedAttemptId)) {
            throw invalid();
        }
        if (rawValue == null || rawValue.isEmpty()) {
            throw invalid();
        }
        if (rawValue.getBytes(StandardCharsets.UTF_8).length > MAX_RAW_VALUE_BYTES) {
            throw invalid();
        }
        return new T4QrPayload(returnedAttemptId, rawValue);
    }

    public static String requireAttemptId(String attemptId) {
        if (attemptId == null || attemptId.isEmpty() || attemptId.length() > MAX_ATTEMPT_ID_LENGTH) {
            throw invalid();
        }
        for (int index = 0; index < attemptId.length(); index += 1) {
            char character = attemptId.charAt(index);
            if (character < 0x21 || character > 0x7e) {
                throw invalid();
            }
        }
        return attemptId;
    }

    public String attemptId() {
        return attemptId;
    }

    public String rawValue() {
        return rawValue;
    }

    private static IllegalArgumentException invalid() {
        return new IllegalArgumentException("Invalid QR scanner result");
    }
}
