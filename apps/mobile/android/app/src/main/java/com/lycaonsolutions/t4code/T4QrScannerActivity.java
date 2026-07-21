package com.lycaonsolutions.t4code;

import android.Manifest;
import android.content.Intent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.IntentFilter;
import android.content.pm.PackageManager;
import android.media.Image;
import android.os.Bundle;
import android.view.View;
import android.view.ViewGroup;
import android.view.Window;

import androidx.activity.OnBackPressedCallback;
import androidx.annotation.NonNull;
import androidx.annotation.OptIn;
import androidx.appcompat.app.AppCompatActivity;
import androidx.camera.core.CameraSelector;
import androidx.camera.core.ExperimentalGetImage;
import androidx.camera.core.ImageAnalysis;
import androidx.camera.core.ImageProxy;
import androidx.camera.core.Preview;
import androidx.camera.lifecycle.ProcessCameraProvider;
import androidx.camera.view.PreviewView;
import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;
import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;

import com.google.common.util.concurrent.ListenableFuture;
import com.google.mlkit.vision.barcode.BarcodeScanner;
import com.google.mlkit.vision.barcode.BarcodeScannerOptions;
import com.google.mlkit.vision.barcode.BarcodeScanning;
import com.google.mlkit.vision.barcode.common.Barcode;
import com.google.mlkit.vision.common.InputImage;

import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicBoolean;

/** Full-screen, app-owned QR scanner. The Capacitor plugin owns permission and launch. */
@OptIn(markerClass = ExperimentalGetImage.class)
public final class T4QrScannerActivity extends AppCompatActivity {
    public static final String EXTRA_ATTEMPT_ID = "attemptId";
    public static final String EXTRA_RAW_VALUE = "rawValue";
    public static final String EXTRA_REASON = "reason";

    private final AtomicBoolean frameInFlight = new AtomicBoolean(false);
    private final T4QrCleanup cleanup = new T4QrCleanup();
    private final AtomicBoolean finishStarted = new AtomicBoolean(false);

    private T4QrTerminalCoordinator terminal;
    private T4QrCaptureState captureState;
    private PreviewView previewView;
    private ExecutorService analyzerExecutor;
    private BarcodeScanner barcodeScanner;
    private ProcessCameraProvider cameraProvider;
    private ImageAnalysis imageAnalysis;
    private BroadcastReceiver cancellationReceiver;
    private boolean cancellationReceiverRegistered;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        configureWindow();
        setContentView(R.layout.activity_t4_qr_scanner);
        terminal = new T4QrTerminalCoordinator(this::runOnUiThread);
        previewView = findViewById(R.id.t4_qr_preview);
        configureSafeInsets();
        findViewById(R.id.t4_qr_cancel).setOnClickListener(view -> cancelExplicitly());
        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                cancelExplicitly();
            }
        });

        try {
            String attemptId = T4QrPayload.requireAttemptId(getIntent().getStringExtra(EXTRA_ATTEMPT_ID));
            captureState = new T4QrCaptureState(attemptId);
        } catch (IllegalArgumentException error) {
            finishWithoutState("invalid_attempt");
            return;
        }

        if (!captureState.started()) {
            finishWithoutState("scanner_state");
            return;
        }

        try {
            registerCancellationReceiver();
        } catch (RuntimeException | LinkageError error) {
            finishFailed("cancellation_receiver");
            return;
        }
        if (consumeRecordedCancellation()) {
            cancelExplicitly();
            return;
        }

        if (ActivityCompat.checkSelfPermission(this, Manifest.permission.CAMERA)
            != PackageManager.PERMISSION_GRANTED) {
            finishFailed("camera_permission");
            return;
        }

        try {
            analyzerExecutor = Executors.newSingleThreadExecutor();
        } catch (RuntimeException | LinkageError error) {
            finishFailed("scanner_executor");
            return;
        }

        try {
            BarcodeScannerOptions options = new BarcodeScannerOptions.Builder()
                .setBarcodeFormats(Barcode.FORMAT_QR_CODE)
                .build();
            barcodeScanner = BarcodeScanning.getClient(options);
        } catch (RuntimeException | LinkageError error) {
            finishFailed("scanner_decoder");
            return;
        }

        if (consumeRecordedCancellation()) {
            cancelExplicitly();
            return;
        }
        bindCamera();
    }

    private void configureWindow() {
        supportRequestWindowFeature(Window.FEATURE_NO_TITLE);
        WindowCompat.setDecorFitsSystemWindows(getWindow(), false);
        WindowInsetsControllerCompat controller = WindowCompat.getInsetsController(
            getWindow(),
            getWindow().getDecorView()
        );
        controller.hide(WindowInsetsCompat.Type.systemBars());
        controller.setSystemBarsBehavior(
            WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
        );
    }

    private void configureSafeInsets() {
        View root = findViewById(R.id.t4_qr_root);
        View status = findViewById(R.id.t4_qr_status);
        View cancel = findViewById(R.id.t4_qr_cancel);
        ViewGroup.MarginLayoutParams statusLayout =
            (ViewGroup.MarginLayoutParams) status.getLayoutParams();
        ViewGroup.MarginLayoutParams cancelLayout =
            (ViewGroup.MarginLayoutParams) cancel.getLayoutParams();
        int statusBaseTopMargin = statusLayout.topMargin;
        int cancelBaseBottomMargin = cancelLayout.bottomMargin;

        ViewCompat.setOnApplyWindowInsetsListener(root, (view, windowInsets) -> {
            Insets safeInsets = windowInsets.getInsets(
                WindowInsetsCompat.Type.systemBars() | WindowInsetsCompat.Type.displayCutout()
            );
            statusLayout.topMargin = statusBaseTopMargin + safeInsets.top;
            cancelLayout.bottomMargin = cancelBaseBottomMargin + safeInsets.bottom;
            status.setLayoutParams(statusLayout);
            cancel.setLayoutParams(cancelLayout);
            return windowInsets;
        });
        ViewCompat.requestApplyInsets(root);
    }

    private void bindCamera() {
        try {
            ListenableFuture<ProcessCameraProvider> future = ProcessCameraProvider.getInstance(this);
            future.addListener(() -> {
                try {
                    ProcessCameraProvider provider = future.get();
                    cameraProvider = provider;
                    if (cleanup.isStarted() || isTerminal()) {
                        provider.unbindAll();
                        return;
                    }

                    Preview preview = new Preview.Builder().build();
                    preview.setSurfaceProvider(previewView.getSurfaceProvider());
                    imageAnalysis = new ImageAnalysis.Builder()
                        .setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST)
                        .build();
                    imageAnalysis.setAnalyzer(analyzerExecutor, this::analyzeFrame);

                    provider.unbindAll();
                    provider.bindToLifecycle(
                        this,
                        CameraSelector.DEFAULT_BACK_CAMERA,
                        preview,
                        imageAnalysis
                    );
                } catch (Exception | LinkageError error) {
                    finishFailed("camera_unavailable");
                }
            }, ContextCompat.getMainExecutor(this));
        } catch (RuntimeException | LinkageError error) {
            finishFailed("camera_provider");
        }
    }

    private void analyzeFrame(@NonNull ImageProxy imageProxy) {
        if (cleanup.isStarted() || isTerminal() || !frameInFlight.compareAndSet(false, true)) {
            imageProxy.close();
            return;
        }

        Image mediaImage = imageProxy.getImage();
        if (mediaImage == null) {
            frameInFlight.set(false);
            imageProxy.close();
            return;
        }

        T4QrFrameSettlement frame = new T4QrFrameSettlement(
            () -> {
                frameInFlight.set(false);
                imageProxy.close();
            },
            terminal,
            () -> {
                if (!cleanup.isStarted()) finishFailedNow("scanner_error");
            }
        );
        try {
            InputImage input = InputImage.fromMediaImage(
                mediaImage,
                imageProxy.getImageInfo().getRotationDegrees()
            );
            var task = barcodeScanner.process(input);
            task.addOnCompleteListener(completedTask -> frame.completed());
            task.addOnFailureListener(error -> frame.failed());
            task.addOnSuccessListener(this::acceptFirstValidQrCode);
        } catch (RuntimeException | LinkageError error) {
            frame.failed();
        }
    }

    private void acceptFirstValidQrCode(List<Barcode> barcodes) {
        if (cleanup.isStarted() || isTerminal()) {
            return;
        }
        for (Barcode barcode : barcodes) {
            String rawValue = barcode.getRawValue();
            try {
                T4QrPayload payload = T4QrPayload.validate(
                    captureState.attemptId(),
                    captureState.attemptId(),
                    rawValue
                );
                Intent result = new Intent()
                    .putExtra(EXTRA_ATTEMPT_ID, payload.attemptId())
                    .putExtra(EXTRA_RAW_VALUE, payload.rawValue());
                terminal.request(() -> finishResultNow(result));
                return;
            } catch (IllegalArgumentException ignored) {
                // Keep scanning. Invalid or oversized data never crosses the activity boundary.
            }
        }
    }

    private void cancelExplicitly() {
        terminal.request(this::finishCancelledNow);
    }

    private void registerCancellationReceiver() {
        cancellationReceiver = new BroadcastReceiver() {
            @Override
            public void onReceive(Context context, Intent intent) {
                if (!T4QrScannerPlugin.ACTION_CANCEL_SCAN.equals(intent.getAction())) {
                    return;
                }
                String returnedAttemptId = intent.getStringExtra(EXTRA_ATTEMPT_ID);
                try {
                    String validAttemptId = T4QrPayload.requireAttemptId(returnedAttemptId);
                    if (!captureState.attemptId().equals(validAttemptId)) {
                        return;
                    }
                    T4QrCancellationRegistry.shared().consume(validAttemptId);
                    cancelExplicitly();
                } catch (IllegalArgumentException ignored) {
                    // A package-scoped cancellation must still match this activity's attempt.
                }
            }
        };
        ContextCompat.registerReceiver(
            this,
            cancellationReceiver,
            new IntentFilter(T4QrScannerPlugin.ACTION_CANCEL_SCAN),
            ContextCompat.RECEIVER_NOT_EXPORTED
        );
        cancellationReceiverRegistered = true;
    }

    private boolean consumeRecordedCancellation() {
        return captureState != null
            && T4QrCancellationRegistry.shared().consume(captureState.attemptId());
    }

    private void finishCancelledNow() {
        if (captureState != null && captureState.cancelled()) {
            finishTerminal(RESULT_CANCELED, reasonResult("cancelled"));
        }
    }

    private void finishFailed(String reason) {
        terminal.request(() -> {
            if (!cleanup.isStarted()) finishFailedNow(reason);
        });
    }

    private void finishFailedNow(String reason) {
        if (captureState != null && captureState.failed()) {
            finishTerminal(RESULT_CANCELED, reasonResult(reason));
        }
    }

    private void finishWithoutState(String reason) {
        terminal.request(
            () -> finishTerminal(RESULT_CANCELED, new Intent().putExtra(EXTRA_REASON, reason))
        );
    }

    private void finishResultNow(Intent result) {
        if (captureState != null && captureState.result()) {
            finishTerminal(RESULT_OK, result);
        }
    }

    private Intent reasonResult(String reason) {
        return new Intent()
            .putExtra(EXTRA_ATTEMPT_ID, captureState.attemptId())
            .putExtra(EXTRA_REASON, reason);
    }

    private boolean isTerminal() {
        if (terminal != null && terminal.isRequested()) {
            return true;
        }
        if (captureState == null) {
            return finishStarted.get();
        }
        T4QrCaptureState.Phase phase = captureState.phase();
        return phase == T4QrCaptureState.Phase.RESULT
            || phase == T4QrCaptureState.Phase.CANCELLED
            || phase == T4QrCaptureState.Phase.FAILED;
    }

    private void finishTerminal(int resultCode, Intent data) {
        if (!finishStarted.compareAndSet(false, true)) {
            return;
        }
        setResult(resultCode, data);
        cleanupScanner(false);
        finish();
    }

    private void cleanupScanner(boolean changingConfigurations) {
        ImageAnalysis analysis = imageAnalysis;
        ProcessCameraProvider provider = cameraProvider;
        BarcodeScanner scanner = barcodeScanner;
        ExecutorService executor = analyzerExecutor;
        BroadcastReceiver receiver = cancellationReceiver;
        boolean unregisterCancellationReceiver = cancellationReceiverRegistered;
        imageAnalysis = null;
        cameraProvider = null;
        barcodeScanner = null;
        analyzerExecutor = null;
        cancellationReceiver = null;
        cancellationReceiverRegistered = false;

        if (captureState != null) {
            T4QrCancellationRegistry.shared().cleanup(
                captureState.attemptId(),
                changingConfigurations
            );
        }

        cleanup.run(
            () -> {
                if (unregisterCancellationReceiver && receiver != null) {
                    unregisterReceiver(receiver);
                }
            },
            () -> {
                if (analysis != null) analysis.clearAnalyzer();
            },
            () -> {
                if (provider != null) provider.unbindAll();
            },
            () -> {
                if (scanner != null) scanner.close();
            },
            () -> {
                if (executor != null) executor.shutdownNow();
            }
        );
    }

    @Override
    protected void onStop() {
        super.onStop();
        if (!isChangingConfigurations() && !isTerminal()) {
            finishFailed("background");
        }
    }

    @Override
    protected void onDestroy() {
        cleanupScanner(isChangingConfigurations());
        super.onDestroy();
    }
}
