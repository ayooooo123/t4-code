# Mobile Host Directory v3 Acceptance

Verified on 2026-07-17 against source commit
`37513df64b20b86031f798db3aa6e13b7ff579fb`.

## Artifact

- Debug APK: `apps/mobile/android/app/build/outputs/apk/debug/app-debug.apk`
- SHA-256: `9097620a7873f45544acca2c963b24fadd73715ef6880a2d4cd799ed021c19c3`
- Android virtual device: `Pixel_10`
- Reported guest model: `sdk_gphone64_arm64`
- API: 36
- ABI: `arm64-v8a`

## Automated gates

| Gate | Result |
| --- | --- |
| Mobile Node suite | PASS — 89 tests |
| Web suite | PASS — 64 files, 961 tests |
| Web typecheck | PASS |
| Android unit test, debug assembly, and lint | PASS — 146 Gradle tasks |
| QR APK inspection | PASS |
| Storage inspector | PASS — 35 tests |

The QR APK inspector reported exactly:

```json
{"cameraX":true,"bundledDecoder":true,"playServicesScannerPath":false,"modelCount":3,"nativeDecoderAbis":["arm64-v8a"]}
```

This is structural APK evidence: CameraX and the bundled offline decoder are
present, and the Play Services scanner path is absent. It is not a physical
camera scan result.

## Clean-install emulator evidence

The APK was uninstalled, installed, package data was cleared, logcat was
cleared, and the application was launched on `emulator-5554`.

- `pidof com.lycaonsolutions.t4code` returned process `2941`.
- `dumpsys activity top` reported
  `com.lycaonsolutions.t4code/.MainActivity` with `mResumed=true`.
- The bounded 2,000-line main/system/crash log window contained no T4-related
  fatal exception, `CameraAccessException`, leaked window/activity, ANR,
  forced finish, or unexpected T4 process death. The only matched T4 event was
  the expected native `T4QrScanner.isSupported` call.
- UIAutomator generated `/private/tmp/t4-v3-ui.xml`, but this emulator image
  exposed only the native `CapacitorWebView` container, not its DOM descendants.
  Therefore the XML does **not** prove the first-run labels or controls.
- A separate bounded CDP evaluation of only `document.body.innerText` confirmed
  the rendered first-run text `Connect to your T4 host`, `Scan QR code`, and
  `Paste private key`. The temporary loopback CDP forward was removed after the
  check. This is DOM text evidence, not a physical camera interaction or a
  visual-layout assertion.

## Bounded v3 storage evidence

After the clean launch, the production-key inspector returned exactly:

```json
{"present":false,"version":null,"activeHost":false,"hostCount":0,"transportKinds":[]}
```

The inspector accepts only the production v3 key and the explicit legacy v2
compatibility key. For present v3 data its output is exactly
`{present,version,activeHost,hostCount,transportKinds}`. It validates the active
host reference and configured transport records, sorts and deduplicates the
kind list, and never returns raw CDP values, IDs, labels, URLs, origins,
fingerprints, invites, capabilities, or credentials.

## Pending and deferred acceptance

- Physical GrapheneOS camera scan and paste flow: **PENDING**.
- Physical-device HyperDHT connection and reconnect: **PENDING**.
- Automatic transport fallback: deferred to the OMP multi-route phase.
- Mobile multi-method host editing: deferred to the host-directory UI phase.
- Direct v3 writes from a brand-new first-run flow: deferred; the current v3
  directory is created by the approved migration path.

No physical-device result, live QR decode, HyperDHT connection, or visual
layout proof is claimed by this emulator acceptance run.
