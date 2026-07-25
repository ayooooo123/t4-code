# Native QR Scanner Hardening Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the crash-prone third-party Android scanner path with a T4-owned CameraX scanner that works without Google Play Services and reliably returns validated HyperDHT pairing invites.

**Architecture:** A non-exported native scanner activity owns CameraX, the preview surface, and the bundled ML Kit decoder. A small Capacitor plugin owns permission checks, attempt IDs, activity results, and cancellation. A web coordinator implements the tokenized scanner state machine and sends a validated invite through the same confirmation path as paste.

**Tech Stack:** Capacitor 8, Android Java 21, CameraX, bundled `com.google.mlkit:barcode-scanning`, React, TypeScript, Vitest/Vite+, JUnit 4, Gradle.

**Spec:** `docs/superpowers/specs/2026-07-16-extensible-remote-transports-design.md`

---

## Chunk 1: T4-owned Android scanner

### Task 1: Define the activity-owned capture state

**Files:**
- Create: `apps/mobile/android/app/src/main/java/com/lycaonsolutions/t4code/T4QrCaptureState.java`
- Create: `apps/mobile/android/app/src/test/java/com/lycaonsolutions/t4code/T4QrCaptureStateTest.java`

- [ ] **Step 1: Write failing capture-state tests**

Cover `STARTING -> SCANNING -> RESULT|CANCELLED|FAILED`, first terminal result wins, duplicate terminal events are ignored, and a cancelled capture rejects late analyzer completion. This instance belongs only to one scanner activity; it is never shared with the plugin or stored statically.

```java
T4QrCaptureState state = new T4QrCaptureState("scan-1");
assertTrue(state.started());
assertTrue(state.result());
assertFalse(state.failed());
assertEquals(T4QrCaptureState.Phase.RESULT, state.phase());
```

- [ ] **Step 2: Run the test and verify RED**

Run: `cd apps/mobile/android && ./gradlew :app:testDebugUnitTest --tests com.lycaonsolutions.t4code.T4QrCaptureStateTest`

Expected: FAIL because `T4QrCaptureState` does not exist.

- [ ] **Step 3: Implement the minimal Android-independent state class**

Validate the attempt ID as a non-empty ASCII token of at most 128 characters and synchronize transitions so CameraX callbacks and UI cancellation cannot both win.

- [ ] **Step 4: Run the focused test and verify GREEN**

Run: `cd apps/mobile/android && ./gradlew :app:testDebugUnitTest --tests com.lycaonsolutions.t4code.T4QrCaptureStateTest`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/mobile/android/app/src/main/java/com/lycaonsolutions/t4code/T4QrCaptureState.java apps/mobile/android/app/src/test/java/com/lycaonsolutions/t4code/T4QrCaptureStateTest.java
git commit -m "test: define native qr capture lifecycle"
```

### Task 2: Build the native CameraX scanner activity

**Files:**
- Create: `apps/mobile/android/app/src/main/java/com/lycaonsolutions/t4code/T4QrPayload.java`
- Create: `apps/mobile/android/app/src/main/java/com/lycaonsolutions/t4code/T4QrScannerActivity.java`
- Create: `apps/mobile/android/app/src/test/java/com/lycaonsolutions/t4code/T4QrPayloadTest.java`
- Create: `apps/mobile/android/app/src/main/res/layout/activity_t4_qr_scanner.xml`
- Create: `apps/mobile/android/app/src/main/res/drawable/t4_qr_scan_frame.xml`
- Modify: `apps/mobile/android/app/src/main/res/values/strings.xml`
- Modify: `apps/mobile/android/app/src/main/AndroidManifest.xml`
- Modify: `apps/mobile/android/app/build.gradle`
- Modify: `apps/mobile/package.json`
- Modify: `apps/mobile/scripts/prepare-web.test.mjs`
- Modify: `pnpm-lock.yaml`

- [ ] **Step 1: Write failing payload and source-contract tests**

In JUnit, reject missing, mismatched, non-ASCII, and oversized attempt IDs plus empty or over-2,048-byte UTF-8 payloads. In `prepare-web.test.mjs`, require `T4QrScannerActivity` with `android:exported="false"`, direct dependencies on CameraX `1.5.2` and bundled `com.google.mlkit:barcode-scanning:17.3.0`, and absence of the old Capacitor ML Kit package, `play-services-code-scanner`, and `com.google.mlkit.vision.DEPENDENCIES=barcode_ui`.

- [ ] **Step 2: Run tests and verify RED**

Run:

```bash
pnpm --filter @t4-code/mobile test
cd apps/mobile/android && ./gradlew :app:testDebugUnitTest --tests com.lycaonsolutions.t4code.T4QrPayloadTest
```

Expected: FAIL because the payload helper/activity are missing and the third-party dependency remains.

- [ ] **Step 3: Implement the payload helper and activity**

The activity owns one `T4QrCaptureState` and must:

- Inflate a full-screen `PreviewView` with a visible frame, status text, and 48dp cancel control.
- Use CameraX camera2/core/lifecycle/view `1.5.2`, `ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST`, and a one-frame-in-flight guard.
- Use `BarcodeScanning.getClient()` from bundled ML Kit `17.3.0`, configured only for `Barcode.FORMAT_QR_CODE`.
- Close each `ImageProxy` exactly once from the ML Kit task's completion callback. Close immediately only when no async task was started.
- Validate result data through `T4QrPayload`, return the matching attempt ID, and ignore late analyzer callbacks after a terminal transition.
- On explicit cancel/back, return `cancelled`. Do not treat `onPause` alone as cancellation.
- On `onStop`, return `background` only when not changing configuration and no terminal result already won. Recreated activities rebind the camera from the intent attempt ID.
- Make analyzer shutdown, provider unbind, ML Kit close, and `finish()` idempotent across cancel/stop/result races.

- [ ] **Step 4: Replace the third-party dependency**

Remove `@capacitor-mlkit/barcode-scanning`, update the pnpm lock, remove generated Capacitor plugin references through `sync:android`, add the exact direct dependencies above, and remove the Play Services model metadata.

- [ ] **Step 5: Run tests, sync, and inspect dependency output**

Run:

```bash
pnpm install --lockfile-only
pnpm --filter @t4-code/mobile sync:android
pnpm --filter @t4-code/mobile test
cd apps/mobile/android && ./gradlew :app:testDebugUnitTest :app:compileDebugJavaWithJavac :app:dependencies --configuration debugRuntimeClasspath
```

Expected: PASS; generated settings contain no `capacitor-mlkit-barcode-scanning`, and `debugRuntimeClasspath` contains CameraX/ML Kit but not `play-services-code-scanner`.

- [ ] **Step 6: Commit the green activity slice**

```bash
git add apps/mobile/package.json pnpm-lock.yaml apps/mobile/scripts/prepare-web.test.mjs apps/mobile/android/app/build.gradle apps/mobile/android/app/src/main/AndroidManifest.xml apps/mobile/android/app/src/main/java/com/lycaonsolutions/t4code/T4QrPayload.java apps/mobile/android/app/src/main/java/com/lycaonsolutions/t4code/T4QrScannerActivity.java apps/mobile/android/app/src/test/java/com/lycaonsolutions/t4code/T4QrPayloadTest.java apps/mobile/android/app/src/main/res/layout/activity_t4_qr_scanner.xml apps/mobile/android/app/src/main/res/drawable/t4_qr_scan_frame.xml apps/mobile/android/app/src/main/res/values/strings.xml apps/mobile/android/capacitor.settings.gradle apps/mobile/android/app/capacitor.build.gradle
git commit -m "feat: add offline native qr scanner activity"
```

### Task 3: Add the cancellable Capacitor scanner plugin

**Files:**
- Create: `apps/mobile/android/app/src/main/java/com/lycaonsolutions/t4code/T4QrPluginSession.java`
- Create: `apps/mobile/android/app/src/main/java/com/lycaonsolutions/t4code/T4QrCancellationRegistry.java`
- Create: `apps/mobile/android/app/src/main/java/com/lycaonsolutions/t4code/T4QrScannerPlugin.java`
- Create: `apps/mobile/android/app/src/test/java/com/lycaonsolutions/t4code/T4QrPluginSessionTest.java`
- Create: `apps/mobile/android/app/src/test/java/com/lycaonsolutions/t4code/T4QrCancellationRegistryTest.java`
- Modify: `apps/mobile/android/app/src/main/java/com/lycaonsolutions/t4code/T4QrScannerActivity.java`
- Modify: `apps/mobile/android/app/src/main/java/com/lycaonsolutions/t4code/MainActivity.java`
- Modify: `apps/mobile/scripts/prepare-web.test.mjs`

- [ ] **Step 1: Write failing plugin-session, cancellation, and source tests**

The pure `T4QrPluginSession` test covers one active attempt, second-start rejection, exact-ID cancellation, result/cancel/error races, duplicate callback idempotency, event-before-settlement ordering represented by a terminal action, and state release after settlement. The cancellation registry test covers cancel-before-activity-registration, matching consume, mismatched attempt isolation, and cleanup. Source tests require plugin registration and exact event/method names.

The plugin contract is:

```text
isSupported() -> { supported }
cameraPermission() -> { camera: granted|prompt|denied|blocked }
requestCameraPermission() -> same stable state
startScan({ attemptId }) -> original call settles after activity result
cancelScan({ attemptId })
scanResult -> { attemptId, rawValue }
scanClosed -> { attemptId, reason }
scanError -> { attemptId, code }
```

- [ ] **Step 2: Run tests and verify RED**

Run:

```bash
pnpm --filter @t4-code/mobile test
cd apps/mobile/android && ./gradlew :app:testDebugUnitTest --tests 'com.lycaonsolutions.t4code.T4QrPluginSessionTest' --tests 'com.lycaonsolutions.t4code.T4QrCancellationRegistryTest'
```

Expected: FAIL because the plugin session, registry, and plugin are missing.

- [ ] **Step 3: Implement attempt-scoped cancellation**

`T4QrCancellationRegistry` is the only application-scoped static unit. It stores bounded cancelled attempt IDs, not activity or plugin instances. `cancelScan` marks the ID and sends an explicit package-scoped, non-exported cancellation broadcast. The activity registers its receiver before camera startup, consumes an already-recorded cancellation immediately, checks again before binding, and unregisters on cleanup. This closes the cancel-before-registration race without persisting anything across process death.

- [ ] **Step 4: Implement Capacitor call and permission ownership**

Use `startActivityForResult(call, intent, "scanFinished")`; Capacitor owns the saved original call. `T4QrPluginSession` stores only the active attempt state, never a second `PluginCall`. Reject another start before launching. The `@ActivityCallback(PluginCall, ActivityResult)` handles a null restored call safely, validates result data through `T4QrPayload`, emits the one terminal event, then resolves/rejects the original call and clears the session in `finally`. The separate `cancelScan` call never replaces the saved original call.

Declare the camera permission on `@CapacitorPlugin`. `isSupported` checks `PackageManager.FEATURE_CAMERA_ANY`. Map Capacitor states to `granted`, `prompt`, and `denied`; persist only a local `camera_requested` boolean so a denied state with no rationale after a prior request maps to `blocked`. `requestCameraPermission` uses a permission callback and returns the same stable mapping.

- [ ] **Step 5: Run native and source checks**

Run:

```bash
pnpm --filter @t4-code/mobile test
cd apps/mobile/android && ./gradlew :app:testDebugUnitTest :app:compileDebugJavaWithJavac
```

Expected: PASS.

- [ ] **Step 6: Commit the green plugin slice**

```bash
git add apps/mobile/android/app/src/main/java/com/lycaonsolutions/t4code/T4QrPluginSession.java apps/mobile/android/app/src/main/java/com/lycaonsolutions/t4code/T4QrCancellationRegistry.java apps/mobile/android/app/src/main/java/com/lycaonsolutions/t4code/T4QrScannerPlugin.java apps/mobile/android/app/src/main/java/com/lycaonsolutions/t4code/T4QrScannerActivity.java apps/mobile/android/app/src/main/java/com/lycaonsolutions/t4code/MainActivity.java apps/mobile/android/app/src/test/java/com/lycaonsolutions/t4code/T4QrPluginSessionTest.java apps/mobile/android/app/src/test/java/com/lycaonsolutions/t4code/T4QrCancellationRegistryTest.java apps/mobile/scripts/prepare-web.test.mjs
git commit -m "feat: expose cancellable native qr scanning"
```

## Chunk 2: Web scanner coordinator and connection UX

### Task 4: Implement the tokenized web scanner coordinator

**Files:**
- Create: `apps/web/src/platform/mobile-qr-scanner.ts`
- Create: `apps/web/test/mobile-qr-scanner.test.ts`
- Modify: `apps/web/src/platform/native-mobile.ts`
- Modify: `apps/web/test/native-mobile.test.tsx`

- [ ] **Step 1: Write failing coordinator tests**

Cover plugin missing, unsupported hardware, permission `prompt`, permission `denied`, permission `blocked`, grant, valid result, invalid result, 60-second timeout, explicit cancel, app background, unmount, `startScan` rejection, result-before-start-resolution, start-resolution-after-cancel, duplicate events, stale attempt IDs, and successful retry after every terminal path. Prove `scanResult`, `scanClosed`, and `scanError` listeners all finish registration before `startScan` is called. For failure during the second or third registration, prove earlier handles are removed and scanning never starts.

The public API returns a controller instead of hiding cancellation:

```ts
const attempt = createMobileQrScanAttempt({ plugin, timeoutMs: 60_000 });
const result = await attempt.result;
attempt.cancel("user");
```

- [ ] **Step 2: Run focused tests and verify RED**

Run: `pnpm --filter @t4-code/web test -- mobile-qr-scanner.test.ts native-mobile.test.tsx`

Expected: FAIL because the coordinator and `T4QrScanner` bridge do not exist.

- [ ] **Step 3: Implement the native bridge type and coordinator**

Keep `native-mobile.ts` responsible only for obtaining the registered plugin and defining its typed contract. Put attempt tokens, permission flow, timer, listener ordering, cleanup, stable errors, and late-event rejection in `mobile-qr-scanner.ts`. Cleanup must be one idempotent promise and must call `cancelScan` when the attempt did not finish normally.

Export `MobileQrScanError` with the exact code union `plugin_missing | camera_unsupported | permission_denied | permission_blocked | scan_timeout | scan_cancelled | invalid_qr | scanner_error`. Map missing plugin/support, stable native permission values, timeout, and parser failure directly. Map native `scanClosed` reasons `cancelled` and `background` to `scan_cancelled` while retaining the internal reason only on the typed error. Map every unknown native error code or rejected plugin call to `scanner_error`. Never expose a native exception message to UI state, logs, or diagnostics.

- [ ] **Step 4: Reuse the existing invite parser**

Pass raw text through one exported `buildPeerPairingCandidate` that calls `parsePeerBackend`. Convert parser failures into `invalid_qr`, never write storage here, and return the validated candidate for UI confirmation. Paste must call the exact same builder. Tests must prove identical scanned and pasted values yield the same preview record and neither path persists anything.

- [ ] **Step 5: Run focused tests and typecheck**

Run:

```bash
pnpm --filter @t4-code/web test -- mobile-qr-scanner.test.ts native-mobile.test.tsx
pnpm --filter @t4-code/web typecheck
```

Expected: PASS.

- [ ] **Step 6: Commit the coordinator**

```bash
git add apps/web/src/platform/mobile-qr-scanner.ts apps/web/src/platform/native-mobile.ts apps/web/test/mobile-qr-scanner.test.ts apps/web/test/native-mobile.test.tsx
git commit -m "feat: coordinate reliable mobile qr scans"
```

### Task 5: Add a visible scan and confirmation flow

**Files:**
- Create: `apps/web/src/components/MobileQrScannerFlow.tsx`
- Create: `apps/web/test/mobile-qr-scanner-ui.test.tsx`
- Modify: `apps/web/src/components/MobileConnectionScreen.tsx`
- Modify: `apps/web/src/main.tsx`
- Modify: `apps/web/src/platform/native-mobile.ts`
- Modify: `apps/web/test/native-mobile.test.tsx`

- [ ] **Step 1: Write failing UI tests**

Cover disabled scan action while capability is loading, scan action hidden with paste guidance after plugin/hardware unavailability, permission guidance, opening/active/cancelling states, native cancel, invalid-code `Scan again`, timeout, safe errors, fingerprint preview, explicit confirmation before storage, and no persistence on dismiss. Assert 44px minimum controls and accessible live status.

Add direct storage tests for clean first run, valid Tailnet v2, valid peer v2, legacy v1, corrupt existing bytes, and storage access failure. Cover a Tailnet record appearing while a scan is active, appearing while paste preview is open, confirmation invoked twice, and refusal preserving the exact prior bytes. Prove scan and paste use the same guarded confirmation path.

- [ ] **Step 2: Run tests and verify RED**

Run: `pnpm --filter @t4-code/web test -- mobile-qr-scanner-ui.test.tsx native-mobile.test.tsx`

Expected: FAIL because the dedicated flow is missing.

- [ ] **Step 3: Implement the flow**

Use a focused mobile dialog/sheet with three phases: instructions, native scan progress, and validated-host preview. The native activity supplies the camera preview and frame. The web surface must remain stable underneath it and recover when Android returns. Confirmation invokes an injected save function; the scanner component never writes local storage itself.

- [ ] **Step 4: Add an atomic first-run persistence boundary**

Extend `MobileBootResult` setup with `mode: "first-run" | "repair"`. `prepareNativeMobileBackend` returns `first-run` only when the legacy, v2, and reserved v3 keys are all absent; any existing valid, corrupt, or temporarily unreadable record uses `repair`. Pass this mode from `main.tsx` to `MobileConnectionScreen`.

Add `writeFirstRunPeerBackend(candidate, storage)`. In one synchronous call, read all three keys, refuse if any key exists or any read fails, and only then write the validated peer v2 record. It never parses, replaces, or removes existing source bytes. A second confirmation therefore refuses. Test the helper directly instead of relying on component timing.

- [ ] **Step 5: Replace the guessed-input startup form**

In `first-run` mode, present explicit `Scan QR code`, `Paste private key`, and `Use Tailscale address` choices. In `repair` mode, do not render scan/paste persistence actions; retain the bounded repair guidance. Remove the current behavior that guesses transport from one URL input. Scan and paste confirmation both call `writeFirstRunPeerBackend`. Host-manager reuse remains deferred until the v3 logical host directory can append a transport without deleting saved Tailscale state.

- [ ] **Step 6: Run focused tests and typecheck**

Run:

```bash
pnpm --filter @t4-code/web test -- mobile-qr-scanner-ui.test.tsx native-mobile.test.tsx
pnpm --filter @t4-code/web typecheck
```

Expected: PASS.

- [ ] **Step 7: Commit the mobile UI**

```bash
git add apps/web/src/components/MobileQrScannerFlow.tsx apps/web/src/components/MobileConnectionScreen.tsx apps/web/src/main.tsx apps/web/src/platform/native-mobile.ts apps/web/test/mobile-qr-scanner-ui.test.tsx apps/web/test/native-mobile.test.tsx
git commit -m "feat: add reliable mobile qr pairing flow"
```

## Chunk 3: Build and runtime acceptance

### Task 6: Verify the APK contains only the offline scan path

**Files:**
- Modify: `apps/mobile/scripts/prepare-web.test.mjs`
- Create: `apps/mobile/scripts/inspect-qr-scanner.mjs`
- Create: `apps/mobile/scripts/inspect-qr-scanner.test.mjs`
- Create: `apps/mobile/scripts/generate-qr-acceptance-fixtures.mjs`
- Create: `apps/mobile/scripts/generate-qr-acceptance-fixtures.test.mjs`
- Create: `apps/mobile/scripts/inspect-mobile-storage.mjs`
- Create: `apps/mobile/scripts/inspect-mobile-storage.test.mjs`
- Modify: `apps/mobile/package.json`
- Modify: `pnpm-lock.yaml`

- [ ] **Step 1: Write a failing APK inspection test**

Test injected command runners and parsers. Require exact CameraX and `com.google.mlkit:barcode-scanning:17.3.0` coordinates. Reject a direct `com.google.android.gms:play-services-code-scanner` or direct unbundled `com.google.android.gms:play-services-mlkit-barcode-scanning` app dependency, any `GmsBarcodeScanning` call site, and barcode dynamic-model manifest metadata independently. Source assertions require `T4QrScannerActivity` to call `BarcodeScanning.getClient()` and never reference `GmsBarcodeScanning`.

Do not reject the transitively named `com.google.android.gms:play-services-mlkit-barcode-scanning` implementation artifact in the bundled coordinate's published POM. Google ships that implementation beneath `com.google.mlkit:barcode-scanning:17.3.0`; it is distinct from selecting the unbundled runtime path. Prove offline packaging instead: inspect the resolved bundled AAR/APK for `assets/mlkit_barcode_models/*.tflite` and the packaged `libbarhopper_v3.so` decoder, while still rejecting Code Scanner, direct unbundled dependencies, dynamic-model metadata, and `GmsBarcodeScanning` usage.

Recorded Task 2 baseline evidence: the resolved `barcode-scanning-17.3.0.aar` contains `barcode_ssd_mobilenet_v1_dmp25_quant.tflite`, `oned_auto_regressor_mobile.tflite`, `oned_feature_extractor_mobile.tflite`, and `libbarhopper_v3.so` for arm64-v8a, armeabi-v7a, x86, and x86_64. Its published POM also explains the transitive implementation artifact above; that artifact name alone is therefore not evidence of the unbundled runtime path.

Fixture tests must allow unrelated Google utility classes, fail for each forbidden coordinate/class/call-site/metadata marker, and fail closed on missing, truncated, or nonzero Gradle/SDK-tool output. Add pinned `qrcode@1.5.4` as a mobile dev dependency and test a deterministic generator that emits one PNG containing `https://example.com/not-t4` and one containing the public non-secret invite `t4peer://v1/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA`; it must reject any caller-supplied invite.

Test a bounded mobile-storage inspector with injected ADB/CDP clients. It may report only `{ present, version, kind, fieldNames, inviteLength }`, never values. It must forward the debuggable WebView socket, evaluate exactly one named local-storage key, reject unexpected shapes, remove the forwarding rule in `finally`, and fail closed when the process, page, or CDP response is unavailable.

- [ ] **Step 2: Run and verify RED**

Run: `node --test apps/mobile/scripts/inspect-qr-scanner.test.mjs apps/mobile/scripts/generate-qr-acceptance-fixtures.test.mjs apps/mobile/scripts/inspect-mobile-storage.test.mjs`

Expected: FAIL because the inspector does not exist.

- [ ] **Step 3: Implement the bounded inspector**

Resolve `ANDROID_SDK_ROOT`, invoke the project Gradle wrapper for `:app:dependencies --configuration debugRuntimeClasspath`, and invoke `$ANDROID_SDK_ROOT/cmdline-tools/latest/bin/apkanalyzer` for manifest, files, and Dex package/class listings. Fail closed when either command is missing, nonzero, empty, or truncated. Pair those results with the source assertions and packaged-model checks above, emit bounded JSON evidence, and never dump local storage or invite values. Class presence is supporting evidence; the reported `playServicesScannerPath:false` requires all direct-coordinate, source, manifest, and Dex checks to pass, and `bundledDecoder:true` requires packaged model plus native decoder evidence.

Implement the storage inspector using `adb shell pidof`, `adb forward tcp:0 localabstract:webview_devtools_remote_<pid>`, the `/json` target list, and the root workspace's pinned `ws` package. Reject any `--key` other than the single approved `t4-code:mobile-backends:v2` key. Evaluate only that key, bound the CDP response before parsing, discard raw data, print the bounded shape, and remove the allocated forward. Errors report structural status only and never include the evaluation result.

- [ ] **Step 4: Build and inspect**

Run:

```bash
pnpm --filter @t4-code/mobile check:android:debug
node apps/mobile/scripts/inspect-qr-scanner.mjs apps/mobile/android/app/build/outputs/apk/debug/app-debug.apk
node apps/mobile/scripts/generate-qr-acceptance-fixtures.mjs /private/tmp/t4-qr-acceptance
```

Expected: PASS and report `cameraX:true`, `bundledDecoder:true`, `playServicesScannerPath:false`.

- [ ] **Step 5: Commit inspection tooling**

```bash
git add apps/mobile/package.json pnpm-lock.yaml apps/mobile/scripts/inspect-qr-scanner.mjs apps/mobile/scripts/inspect-qr-scanner.test.mjs apps/mobile/scripts/generate-qr-acceptance-fixtures.mjs apps/mobile/scripts/generate-qr-acceptance-fixtures.test.mjs apps/mobile/scripts/inspect-mobile-storage.mjs apps/mobile/scripts/inspect-mobile-storage.test.mjs apps/mobile/scripts/prepare-web.test.mjs
git commit -m "test: verify offline android qr scanner"
```

### Task 7: Emulator crash and lifecycle acceptance

**Files:**
- Create: `docs/QR_SCANNER_ACCEPTANCE.md`
- Modify only explicit files required by failures found during this task.

- [ ] **Step 1: Run complete automated checks**

Run:

```bash
pnpm --filter @t4-code/mobile test
pnpm --filter @t4-code/web test
pnpm --filter @t4-code/protocol test
pnpm --filter @t4-code/client test
pnpm --filter @t4-code/desktop test
pnpm test
pnpm typecheck
pnpm --filter @t4-code/mobile check:android:debug
```

Expected: PASS.

- [ ] **Step 2: Start the pinned emulator and install cleanly**

Use the installed `Pixel_10` AVD: API 36, arm64-v8a, back camera `virtualscene`. If no emulator is running, start it in a persistent PTY on port 5554 and keep that process/session alive while subsequent commands run. Do not run the foreground emulator and ADB commands in one shell. Poll `sys.boot_completed` every two seconds for at most 120 seconds, then verify AVD name, API, and ABI. Every later command uses the pinned serial `emulator-5554`.

Run:

```bash
/Users/jd/Library/Android/sdk/emulator/emulator -avd Pixel_10 -port 5554 -no-snapshot-load -no-boot-anim
adb -s emulator-5554 wait-for-device
adb -s emulator-5554 shell getprop sys.boot_completed
adb -s emulator-5554 emu avd name
adb -s emulator-5554 shell getprop ro.build.version.sdk
adb -s emulator-5554 shell getprop ro.product.cpu.abi
adb -s emulator-5554 uninstall com.lycaonsolutions.t4code
adb -s emulator-5554 install apps/mobile/android/app/build/outputs/apk/debug/app-debug.apk
adb -s emulator-5554 shell pm clear com.lycaonsolutions.t4code
adb -s emulator-5554 shell monkey -p com.lycaonsolutions.t4code 1
```

Expected: boot property becomes `1`, AVD name is `Pixel_10`, API is `36`, ABI is `arm64-v8a`, uninstall may report only `Unknown package` on the first run, install/clear succeed, and the app launches into true first-run setup without a fatal exception.

- [ ] **Step 3: Exercise permission and lifecycle paths**

Before each scenario run `adb -s emulator-5554 logcat -c`. Then use this sequence:

1. Clear app data, launch, choose `Scan QR code`, deny the first camera prompt, and verify `permission_denied` guidance plus paste fallback.
2. Open scan again and deny until Android stops prompting; verify `permission_blocked`. Open app details with `adb -s emulator-5554 shell am start -a android.settings.APPLICATION_DETAILS_SETTINGS -d package:com.lycaonsolutions.t4code`, grant Camera, return, and verify recovery.
3. With permission granted, open and cancel the scanner ten times. After each return run `adb -s emulator-5554 shell uiautomator dump /sdcard/t4-ui.xml`, `adb -s emulator-5554 pull /sdcard/t4-ui.xml /private/tmp/t4-qr-acceptance/ui-<n>.xml`, and `adb -s emulator-5554 shell dumpsys activity top`. Confirm the dump contains the first-run setup controls, the top/resumed activity is `MainActivity`, and `T4QrScannerActivity` is not top or resumed.
4. Start scanning, press Home with `adb -s emulator-5554 shell input keyevent KEYCODE_HOME`, relaunch, and verify a bounded cancelled/background state rather than a stale preview.
5. Start scanning, force-stop, relaunch, and confirm the plugin accepts a fresh attempt.

After every scenario capture `adb -s emulator-5554 logcat -b main -b system -b crash -d -v threadtime -t 2000`. Preserve bounded redacted output and assert there is no T4-related `FATAL EXCEPTION`, `CameraAccessException`, leaked activity/window, analyzer-after-close failure, or unexpected process death. Record the Step 5 force-stop as intentional and distinguish it from crash evidence. Do not filter only by package because `AndroidRuntime` owns fatal records.

- [ ] **Step 4: Exercise a valid and invalid QR result**

Use only the Pixel_10 AVD's configured `virtualscene` back camera. Generate fixtures with Task 6, open Emulator Extended Controls → Camera → Virtual scene images, import `/private/tmp/t4-qr-acceptance/invalid.png` onto the wall poster, and aim the virtual camera at it. Verify `invalid_qr` and `Scan again`. Replace the poster with `/private/tmp/t4-qr-acceptance/valid.png`, scan again, and verify the fixed public test fingerprint preview.

Before scanning, after dismiss, and after confirmation, run `node apps/mobile/scripts/inspect-mobile-storage.mjs --serial emulator-5554 --package com.lycaonsolutions.t4code --key t4-code:mobile-backends:v2`. Expected shapes are absent, absent, then exactly `{ present:true, version:2, kind:"peer", fieldNames:["invite","kind","label","version"], inviteLength:<bounded number> }`. The script never prints the invite. The fixed fixture is not a real capability and neither its raw value nor any real invite enters logs or committed acceptance evidence.

- [ ] **Step 5: Document the physical GrapheneOS checkpoint**

Record the commit SHA, APK SHA-256, AVD/API/ABI, emulator serial, timestamps, and each scenario result. Add a physical checklist for fresh install, camera deny/grant, repeated scan/cancel, valid pairing, background/relaunch, and no Google services installed. Mark physical GrapheneOS status `PENDING` unless those steps were executed on the exact recorded APK hash; emulator success is never reported as GrapheneOS acceptance.

- [ ] **Step 6: Commit verification fixes and documentation**

For every implementation failure found above, first add a focused failing regression test, implement the minimum fix, run the focused and full affected suites, and commit that test plus fix together. Then commit the acceptance record separately:

```bash
git add docs/QR_SCANNER_ACCEPTANCE.md
git commit -m "docs: record android qr scanner acceptance"
git diff --check
git status --short
```

Expected: diff check exits zero and status is clean. Do not create an empty verification-fix commit.
