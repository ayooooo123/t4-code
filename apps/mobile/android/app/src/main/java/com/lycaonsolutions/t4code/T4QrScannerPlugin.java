package com.lycaonsolutions.t4code;

import android.Manifest;
import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;

import androidx.activity.result.ActivityResult;
import androidx.core.app.ActivityCompat;

import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

@CapacitorPlugin(name = "T4QrScanner",
    permissions = {
        @Permission(alias = "camera", strings = { Manifest.permission.CAMERA })
    }
)
public final class T4QrScannerPlugin extends Plugin {
    static final String ACTION_CANCEL_SCAN =
        "com.lycaonsolutions.t4code.action.CANCEL_QR_SCAN";

    private static final String CAMERA_ALIAS = "camera";
    private static final String PREFERENCES = "t4_qr_scanner";
    private static final String CAMERA_REQUESTED = "camera_requested";

    private final T4QrPluginSession session = new T4QrPluginSession();

    @PluginMethod
    public void isSupported(PluginCall call) {
        boolean supported = getContext()
            .getPackageManager()
            .hasSystemFeature(PackageManager.FEATURE_CAMERA_ANY);
        call.resolve(new JSObject().put("supported", supported));
    }

    @PluginMethod
    public void cameraPermission(PluginCall call) {
        resolveCameraPermission(call);
    }

    @PluginMethod
    public void requestCameraPermission(PluginCall call) {
        if (getPermissionState(CAMERA_ALIAS) == PermissionState.GRANTED) {
            resolveCameraPermission(call);
            return;
        }
        preferences().edit().putBoolean(CAMERA_REQUESTED, true).apply();
        requestPermissionForAlias(CAMERA_ALIAS, call, "cameraPermissionFinished");
    }

    @PermissionCallback
    private void cameraPermissionFinished(PluginCall call) {
        if (call != null) {
            resolveCameraPermission(call);
        }
    }

    @PluginMethod
    public void startScan(PluginCall call) {
        String attemptId;
        try {
            attemptId = T4QrPayload.requireAttemptId(call.getString("attemptId"));
        } catch (IllegalArgumentException error) {
            call.reject("Invalid QR scan attempt", "invalid_attempt");
            return;
        }
        if (getPermissionState(CAMERA_ALIAS) != PermissionState.GRANTED) {
            call.reject("Camera permission is required", "camera_permission");
            return;
        }
        if (!session.start(attemptId)) {
            call.reject("A QR scan is already active", "scan_active");
            return;
        }

        T4QrCancellationRegistry.shared().remove(attemptId);
        Intent intent = new Intent(getContext(), T4QrScannerActivity.class)
            .putExtra(T4QrScannerActivity.EXTRA_ATTEMPT_ID, attemptId);
        try {
            startActivityForResult(call, intent, "scanFinished");
        } catch (RuntimeException | LinkageError error) {
            settle(session.error(attemptId, "scanner_launch"), call);
        }
    }

    @PluginMethod
    public void cancelScan(PluginCall call) {
        String attemptId;
        try {
            attemptId = T4QrPayload.requireAttemptId(call.getString("attemptId"));
        } catch (IllegalArgumentException error) {
            call.reject("Invalid QR scan attempt", "invalid_attempt");
            return;
        }
        if (!attemptId.equals(session.activeAttemptId())) {
            call.reject("QR scan attempt is not active", "scan_not_active");
            return;
        }

        T4QrCancellationRegistry.shared().record(attemptId);
        Intent cancellation = new Intent(ACTION_CANCEL_SCAN)
            .setPackage(getContext().getPackageName())
            .putExtra(T4QrScannerActivity.EXTRA_ATTEMPT_ID, attemptId);
        try {
            getContext().sendBroadcast(cancellation);
            call.resolve(new JSObject().put("attemptId", attemptId));
        } catch (RuntimeException | LinkageError error) {
            T4QrCancellationRegistry.shared().remove(attemptId);
            call.reject("Unable to cancel QR scan", "cancellation_failed");
        }
    }

    @ActivityCallback
    private void scanFinished(PluginCall call, ActivityResult result) {
        String expectedAttemptId = session.activeAttemptId();
        if (expectedAttemptId == null) {
            return;
        }
        Intent data = result == null ? null : result.getData();
        T4QrPluginSession.TerminalAction action;
        try {
            if (result != null && result.getResultCode() == Activity.RESULT_OK && data != null) {
                action = session.result(
                    data.getStringExtra(T4QrScannerActivity.EXTRA_ATTEMPT_ID),
                    data.getStringExtra(T4QrScannerActivity.EXTRA_RAW_VALUE)
                );
            } else {
                action = terminalFromClosure(expectedAttemptId, data);
            }
        } catch (RuntimeException | LinkageError error) {
            action = session.error(expectedAttemptId, "invalid_result");
        }
        settle(action, call);
    }

    private T4QrPluginSession.TerminalAction terminalFromClosure(
        String expectedAttemptId,
        Intent data
    ) {
        if (data == null) {
            return session.error(expectedAttemptId, "missing_result");
        }
        String returnedAttemptId = data.getStringExtra(T4QrScannerActivity.EXTRA_ATTEMPT_ID);
        String validReturnedAttemptId = T4QrPayload.requireAttemptId(returnedAttemptId);
        if (!expectedAttemptId.equals(validReturnedAttemptId)) {
            throw new IllegalArgumentException("Invalid QR scanner result");
        }
        String reason = data.getStringExtra(T4QrScannerActivity.EXTRA_REASON);
        if ("cancelled".equals(reason) || "background".equals(reason)) {
            return session.closed(expectedAttemptId, reason);
        }
        return session.error(expectedAttemptId, reason == null || reason.isEmpty()
            ? "scanner_error"
            : reason);
    }

    private void settle(T4QrPluginSession.TerminalAction action, PluginCall call) {
        if (action == null) {
            return;
        }
        try {
            session.settle(action, this::emitTerminalEvent, terminal -> settleCall(call, terminal));
        } catch (RuntimeException | LinkageError ignored) {
            // The event and original call were attempted in order; bridge failures stay native.
        } finally {
            T4QrCancellationRegistry.shared().remove(action.attemptId());
        }
    }

    private void emitTerminalEvent(T4QrPluginSession.TerminalAction action) {
        JSObject payload = terminalPayload(action);
        switch (action.eventName()) {
            case "scanResult" -> notifyListeners("scanResult", payload);
            case "scanClosed" -> notifyListeners("scanClosed", payload);
            default -> notifyListeners("scanError", payload);
        }
    }

    private void settleCall(PluginCall call, T4QrPluginSession.TerminalAction action) {
        if (call == null) {
            return;
        }
        JSObject payload = terminalPayload(action);
        if (action.settlement() == T4QrPluginSession.Settlement.REJECT) {
            call.reject("QR scan failed", action.value(), payload);
        } else {
            call.resolve(payload);
        }
    }

    private JSObject terminalPayload(T4QrPluginSession.TerminalAction action) {
        JSObject payload = new JSObject().put("attemptId", action.attemptId());
        switch (action.eventName()) {
            case "scanResult" -> payload.put("rawValue", action.value());
            case "scanClosed" -> payload.put("reason", action.value());
            default -> payload.put("code", action.value());
        }
        return payload;
    }

    private void resolveCameraPermission(PluginCall call) {
        call.resolve(new JSObject().put("camera", stableCameraPermission()));
    }

    private String stableCameraPermission() {
        PermissionState permissionState = getPermissionState(CAMERA_ALIAS);
        if (permissionState == PermissionState.GRANTED) {
            return "granted";
        }
        if (permissionState == PermissionState.PROMPT) {
            return "prompt";
        }
        if (permissionState == PermissionState.PROMPT_WITH_RATIONALE) {
            return "denied";
        }
        boolean requested = preferences().getBoolean(CAMERA_REQUESTED, false);
        boolean canExplain = ActivityCompat.shouldShowRequestPermissionRationale(
            getActivity(),
            Manifest.permission.CAMERA
        );
        return requested && !canExplain ? "blocked" : "denied";
    }

    private SharedPreferences preferences() {
        return getContext().getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE);
    }
}
