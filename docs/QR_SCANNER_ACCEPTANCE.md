# Android QR scanner acceptance

Status: **PARTIAL — emulator lifecycle PASS; fixture decode, privacy inspection, and physical GrapheneOS remain PENDING**

## Recorded artifact and environment

- Source commit: `8d479a9c86d4155501a49a139477b7857a113f9c`
- APK: `apps/mobile/android/app/build/outputs/apk/debug/app-debug.apk`
- APK SHA-256: `b18ddc2696e52986150ba5aa950a262755a77b18251fd950e014ff60e591792c`
- APK size/build time: `15,559,731` bytes; `2026-07-16T21:13:59-0400`
- Acceptance window: `2026-07-17T01:01Z`–`2026-07-17T01:33Z`
- Emulator serial: `emulator-5554`
- AVD: `Pixel_10`
- Android API: `36`
- ABI: `arm64-v8a`
- Back camera: AVD `virtualscene`
- Physical GrapheneOS: **PENDING**

The APK was rebuilt after `8d479a9` fixed Android sync to rebuild the current web app before copying its assets. The packaged APK was inspected for the new scan-flow markers (`Opening camera`, `Review key`, and the camera-unavailable paste fallback) before installation. The earlier stale APK hash `00b7bfa1…` is not the accepted artifact.

## Automated verification

| Check | Result | Evidence |
| --- | --- | --- |
| Mobile script suite | PASS | 82/82 tests |
| Web suite | PASS | 61 files, 822/822 tests |
| Protocol suite | PASS | 6 files, 26/26 tests |
| Repository typecheck | PASS | 9/9 projects |
| Android unit tests | PASS | `:app:testDebugUnitTest`, Gradle success |
| Android debug assembly | PASS | `:app:assembleDebug`, Gradle success |
| Android lint | PASS | `:app:lintDebug`, Gradle success |
| Client suite | ENVIRONMENT-LIMITED | 130/132 passed; two loopback-listen tests failed only with sandbox `EPERM` on `127.0.0.1` |
| Desktop suite | ENVIRONMENT-LIMITED | 109/115 passed; six Unix-socket tests failed only with sandbox `EPERM` under `/private/tmp` |
| Root `pnpm test` | NOT RE-RUN | The same demonstrated sandbox socket restriction prevents a clean root result |
| Composite mobile check | SPLIT PASS | Web rebuild and Capacitor sync passed; the sandbox blocked the wrapper lock, so unit/assemble/lint were run separately through approved Gradle commands and passed |

No source failure was inferred from the environment-only socket errors.

## Emulator acceptance

Classification: **UI-automated** means ADB drove the visible Android UI and assertions used UI hierarchy/activity/log evidence. **Automated** means a script or build command produced the assertion. **Manual pending** means no result is claimed.

| Scenario | Class | Result | Evidence |
| --- | --- | --- | --- |
| Clean uninstall/install/data clear/launch | UI-automated | PASS | Install and clear returned `Success`; first-run scan-first pairing sheet rendered |
| First camera request and denial | UI-automated | PASS | Native Android permission controller appeared; denial returned `Camera permission is needed to scan a connection key.`, `Scan again`, and `Paste private key` |
| Permission permanently blocked guidance | UI-automated | PENDING | One real denial was exercised. Synthetic `USER_FIXED` flags did not produce trustworthy equivalent UI evidence, so `permission_blocked` is not claimed |
| Settings/grant recovery | UI-automated | PASS | Granting Camera then retrying made `T4QrScannerActivity` top/resumed with live `virtualscene` preview |
| Ten open/cancel cycles | UI-automated | PASS | 10/10 returns had `MainActivity` top/resumed; each `ui-1.xml`…`ui-10.xml` contained setup/`Scan again` and no scanner activity |
| Background/Home then relaunch | UI-automated | PASS | Relaunch returned bounded `QR scanning was cancelled.` state with retry; no stale preview |
| Intentional force-stop then fresh attempt | UI-automated | PASS | After relaunch, a fresh attempt made a new `T4QrScannerActivity` top/resumed |
| Invalid public fixture decode | Manual pending | PENDING | `virtualscene-image` accepted the fixed PNG, but the standalone emulator exposed no reliable automated scene-aim control; the attempt timed out. No `invalid_qr` claim is made |
| Valid public fixture preview/confirmation | Manual pending | PENDING | Same virtual-scene aiming limitation; no pairing or persistence claim is made |
| Privacy-safe storage inspection | Automated | PENDING | Inspector failed closed because this sandbox denies its CDP loopback socket. No ad-hoc raw storage inspection was used |

The emulator's one-time system `Viewing full screen` education overlay was dismissed before cancel-loop interaction; it is Android System UI, not application state.

## Crash and cleanup evidence

Before scenarios, logcat was cleared. Bounded captures used all of `main`, `system`, and `crash` buffers rather than filtering only by package. The repeated lifecycle capture retained the most recent 2,000 lines.

- No T4-related `FATAL EXCEPTION`.
- No `CameraAccessException`.
- No leaked activity or leaked window record.
- No analyzer-after-close failure.
- No T4 ANR or unexpected process death.
- CameraX reported its camera `CLOSED`, surface use count `0`, and open camera count `0` after cancellation.
- The force-stop scenario was intentional and is not classified as crash evidence.

The fixed public fixture hashes are:

- valid: `d5a49334a622b79ee701f64e3c6990ee3cf2c7c8778145892d756e2c87716e5f`
- invalid: `134558139da9f957dd516d562fa0cc164bb57a790ccda66e278ca569794fed1a`

Neither a real invite nor the raw fixed fixture payload is recorded here or in the retained log assertions.

## Physical GrapheneOS checkpoint — PENDING

Run these steps on the exact APK hash recorded above, on a device with no Google services installed:

- [ ] Fresh install enters first-run setup without a crash.
- [ ] Deny Camera once and confirm denial guidance plus paste fallback.
- [ ] Deny until Android blocks prompting and confirm settings guidance.
- [ ] Grant Camera in system settings and confirm scanner recovery.
- [ ] Open and cancel the scanner ten times without a crash or stale preview.
- [ ] Scan the invalid fixed fixture and confirm `invalid_qr` plus retry.
- [ ] Scan the valid fixed fixture, confirm only the public test fingerprint, and verify persistence only after explicit confirmation.
- [ ] Background/relaunch and force-stop/relaunch both accept a fresh attempt.
- [ ] Re-run the privacy-safe storage inspector where CDP loopback is permitted.
- [ ] Capture bounded all-buffer logcat and confirm the same crash/leak assertions.

Emulator success is not GrapheneOS acceptance.
