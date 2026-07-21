package com.lycaonsolutions.t4code;

import org.junit.Test;

import java.nio.charset.StandardCharsets;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertThrows;

public final class T4QrPayloadTest {
    @Test
    public void acceptsMatchingAttemptAndBoundedUtf8Payload() {
        T4QrPayload payload = T4QrPayload.validate("scan-1", "scan-1", "t4-peer://pairing");

        assertEquals("scan-1", payload.attemptId());
        assertEquals("t4-peer://pairing", payload.rawValue());
    }

    @Test
    public void rejectsMissingAttemptIds() {
        assertInvalid(null, "scan-1", "value");
        assertInvalid("", "scan-1", "value");
        assertInvalid("scan-1", null, "value");
        assertInvalid("scan-1", "", "value");
    }

    @Test
    public void rejectsMismatchedAttemptIds() {
        assertInvalid("scan-1", "scan-2", "value");
    }

    @Test
    public void rejectsNonAsciiAttemptIds() {
        assertInvalid("scan-é", "scan-é", "value");
        assertInvalid("scan-1", "scan-é", "value");
        assertInvalid("has space", "has space", "value");
    }

    @Test
    public void rejectsOversizedAttemptIds() {
        String oversized = repeat("a", 129);
        assertInvalid(oversized, oversized, "value");
        assertInvalid("scan-1", oversized, "value");
    }

    @Test
    public void rejectsEmptyPayload() {
        assertInvalid("scan-1", "scan-1", null);
        assertInvalid("scan-1", "scan-1", "");
    }

    @Test
    public void enforcesPayloadLimitInUtf8Bytes() {
        String boundary = repeat("é", 1_024);
        assertEquals(2_048, boundary.getBytes(StandardCharsets.UTF_8).length);
        assertEquals(boundary, T4QrPayload.validate("scan-1", "scan-1", boundary).rawValue());

        String oversized = boundary + "a";
        assertEquals(2_049, oversized.getBytes(StandardCharsets.UTF_8).length);
        assertInvalid("scan-1", "scan-1", oversized);
    }

    private static void assertInvalid(String expected, String actual, String value) {
        assertThrows(IllegalArgumentException.class, () -> T4QrPayload.validate(expected, actual, value));
    }

    private static String repeat(String value, int count) {
        return value.repeat(count);
    }
}
