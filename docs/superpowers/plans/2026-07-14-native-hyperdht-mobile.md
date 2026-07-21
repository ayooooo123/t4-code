# Native HyperDHT Mobile Connection Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let desktop T4 Code issue a QR/copyable peer invite that the bundled Android app scans or pastes to establish an encrypted HyperDHT connection to its local OMP appserver.

**Architecture:** Desktop Electron runs the official JavaScript HyperDHT server and bridges one authorized encrypted stream to its existing Unix-socket WebSocket appserver connection. Android runs `hyperdht-cpp` as a dynamically linked native library behind a Kotlin/JNI Capacitor plugin. The web UI uses a native peer transport that implements the existing `OmpTransport` contract, so the OMP protocol remains unchanged.

**Tech Stack:** Electron, TypeScript, `hyperdht`, `ws`, Capacitor 8, Kotlin/JNI, CMake, `hyperdht-cpp`, Gradle, Vitest, Node test runner.

---

## File structure

| Path | Responsibility |
| --- | --- |
| `packages/protocol/src/peer-invite.ts` | Versioned invite codec, validation, safe metadata, and redaction helpers. |
| `packages/protocol/src/peer-wire.ts` | Length-bounded, versioned frames for authentication and WebSocket message relay. |
| `apps/desktop/src/peer-share.ts` | In-memory desktop share lifecycle, HyperDHT listener, capability check, and OMP bridge. |
| `apps/desktop/src/peer-share.test.ts` | Deterministic lifecycle, authorization, expiry, and secret-redaction tests. |
| `apps/mobile/android/app/src/main/cpp/` | JNI adapter and CMake integration around the pinned `hyperdht-cpp` shared library. |
| `apps/mobile/android/app/src/main/java/com/lycaonsolutions/t4code/T4PeerPlugin.java` | Capacitor-facing lifecycle, input validation, and bounded base64 event bridge. |
| `apps/web/src/platform/peer-transport.ts` | Browser-side `OmpTransport` implementation backed by the Capacitor peer plugin. |
| `apps/web/src/components/MobileConnectionScreen.tsx` | Peer-key paste, QR scan, connection state, and Tailnet alternative. |
| `apps/web/src/components/PeerShareDialog.tsx` | Desktop QR/key display and stop/regenerate controls. |
| `docs/PEER_REMOTE.md` | Setup, security model, license notices, and recovery guidance. |

## Chunk 1: Shared, testable peer protocol

### Task 1: Add invite codec tests before implementation

**Files:**
- Create: `packages/protocol/test/peer-invite.test.ts`
- Create: `packages/protocol/src/peer-invite.ts`
- Modify: `packages/protocol/src/index.ts`

- [ ] **Step 1: Write failing tests for a valid version-1 invite.**

  Cover encode → parse round-trip for a 32-byte desktop public key and a 32-byte capability secret; assert canonical `t4peer://v1/.../...` output and safe metadata that never contains the secret.

- [ ] **Step 2: Run the focused test and confirm it fails because the module is absent.**

  Run: `pnpm --filter @t4-code/protocol test -- peer-invite.test.ts`

- [ ] **Step 3: Implement only the codec and validators required by the failing tests.**

  Use strict base64url decoding, exact 32-byte inputs, a maximum invite length, no implicit whitespace inside segments, and public error messages that do not echo the input.

- [ ] **Step 4: Re-run the focused test and confirm it passes.**

- [ ] **Step 5: Add failing invalid-input and redaction tests, implement their minimum validation, and re-run.**

  Include malformed schemes, unknown versions, missing segments, noncanonical base64url, wrong lengths, control characters, and checks that thrown errors / JSON metadata never include the capability.

- [ ] **Step 6: Commit the completed invite codec.**

  Run: `git add packages/protocol && git commit -m "feat: add peer invite codec"`

### Task 2: Define the encrypted stream framing

**Files:**
- Create: `packages/protocol/src/peer-wire.ts`
- Create: `packages/protocol/test/peer-wire.test.ts`
- Modify: `packages/protocol/src/index.ts`

- [ ] **Step 1: Write failing tests for frame encode/decode and partial-buffer handling.**

  Define an outer frame as `u32 big-endian length` followed by a versioned compact JSON control frame or a binary payload frame. Cover split reads, coalesced reads, 4 MiB maximum payload, unknown type rejection, and bounded close reasons.

- [ ] **Step 2: Run the focused test and confirm it fails for the missing module.**

- [ ] **Step 3: Implement a small incremental decoder and encoder.**

  Frame types are `hello`, `challenge`, `authorize`, `authorized`, `message`, `close`, and `error`. The desktop generates a random challenge; Android returns an HMAC-SHA-256 proof over protocol version, challenge, and desktop public key using the invite capability. The peer is authorized only after constant-time proof comparison.

- [ ] **Step 4: Re-run focused tests.**

- [ ] **Step 5: Add and pass replay, wrong-secret, oversize, and invalid-order tests.**

- [ ] **Step 6: Commit the peer wire module.**

  Run: `git add packages/protocol && git commit -m "feat: define peer stream protocol"`

## Chunk 2: Desktop share host

### Task 3: Add the pinned JavaScript HyperDHT dependency and host unit tests

**Files:**
- Modify: `apps/desktop/package.json`
- Modify: `pnpm-lock.yaml`
- Create: `apps/desktop/src/peer-share.ts`
- Create: `apps/desktop/test/peer-share.test.ts`

- [ ] **Step 1: Add failing tests using fake DHT server/socket and fake OMP WebSocket factories.**

  Test start/status, one active share only, 15-minute expiry, one-phone admission, old invite rejection after regenerate, explicit stop, appserver bridge close propagation, and redaction of the secret in every public status/error value.

- [ ] **Step 2: Run the focused Vitest file and confirm the host module is missing.**

  Run: `pnpm --filter @t4-code/desktop test -- peer-share.test.ts`

- [ ] **Step 3: Add the current pinned `hyperdht` dependency and implement the minimal `PeerShareHost`.**

  `PeerShareHost` owns a single ephemeral DHT key pair, capability, listener, timer, and accepted stream. It must bind only after the share is explicitly started, discard all state after stop/expiry/regenerate, and expose public status with no secret.

- [ ] **Step 4: Implement the OMP bridge after authentication succeeds.**

  Open the existing Unix-domain WebSocket (`ws://omp.local/ws` with the validated appserver socket path), relay message boundaries through `peer-wire`, enforce the existing 4 MiB message limit and bounded queues, and close both sides on an invalid frame or either peer closing.

- [ ] **Step 5: Re-run focused tests and then the desktop suite.**

  Run: `pnpm --filter @t4-code/desktop test`

- [ ] **Step 6: Commit the desktop host.**

  Run: `git add apps/desktop/package.json pnpm-lock.yaml apps/desktop/src/peer-share.ts apps/desktop/test/peer-share.test.ts && git commit -m "feat: host peer connections from desktop"`

### Task 4: Expose share lifecycle through the safe Electron IPC boundary

**Files:**
- Modify: `packages/protocol/src/desktop-ipc.ts`
- Modify: `packages/protocol/test/desktop-ipc.test.ts` (or existing protocol test owning decoder coverage)
- Modify: `apps/desktop/src/ipc.ts`
- Modify: `apps/desktop/src/preload.ts`
- Modify: `apps/desktop/src/lifecycle.ts`
- Modify: `apps/desktop/test/ipc-lifecycle.test.ts`
- Modify: `apps/desktop/test/lifecycle-runtime.test.ts`

- [ ] **Step 1: Write failing protocol tests for `omp:peer-share:start`, `status`, `stop`, and `regenerate`.**

  The public result includes only state, expiry, and the complete invite when the renderer explicitly requests it. It must reject unknown fields and untrusted senders.

- [ ] **Step 2: Run focused protocol tests and confirm the new channels are rejected.**

- [ ] **Step 3: Extend decoders, IPC registry, preload allowlist, and lifecycle wiring.**

  `DesktopLifecycle` constructs `PeerShareHost` with the same local appserver path policy used by `UnixWebSocketTransport`, shuts it down during app teardown, and passes only validated/public results to the renderer.

- [ ] **Step 4: Add and pass desktop IPC tests for sender validation, lifecycle shutdown, and secret redaction.**

- [ ] **Step 5: Commit the IPC integration.**

  Run: `git add packages/protocol apps/desktop && git commit -m "feat: expose desktop peer sharing controls"`

### Task 5: Add desktop share controls and QR rendering

**Files:**
- Create: `apps/web/src/components/PeerShareDialog.tsx`
- Create: `apps/web/test/peer-share-dialog.test.tsx`
- Modify: `apps/web/src/components/Titlebar.tsx` (or the existing desktop connection/settings control that owns remote access)
- Modify: `apps/web/src/platform/bridge.ts`

- [ ] **Step 1: Write a failing renderer test for share state transitions.**

  Assert desktop-only rendering, start then copy key/QR visibility, expiry text, stop, regenerate confirmation, unavailable-state copy, and no Tailnet UI regressions.

- [ ] **Step 2: Run the focused test and confirm it fails.**

- [ ] **Step 3: Implement the dialog using a pinned QR encoder dependency.**

  Generate the QR locally from the exact `t4peer://` invite; never log it. Copy requires an explicit user action. Regenerate requires confirmation because it immediately disconnects the phone.

- [ ] **Step 4: Re-run focused UI tests and the web suite.**

- [ ] **Step 5: Commit the desktop UI.**

  Run: `git add apps/web package.json pnpm-lock.yaml && git commit -m "feat: show peer key and QR on desktop"`

## Chunk 3: Android native HyperDHT bridge

### Task 6: Vendor and prove the native dependency boundary

**Files:**
- Add: `third_party/hyperdht-cpp` (pinned Git submodule at an audited tag/commit)
- Create: `third_party/hyperdht-cpp.LICENSES.md`
- Modify: `.gitmodules`
- Modify: `THIRD_PARTY_NOTICES.md`
- Modify: `apps/mobile/android/settings.gradle`
- Create: `apps/mobile/android/app/src/main/cpp/CMakeLists.txt`

- [ ] **Step 1: Add a provenance/notice test that fails without the exact upstream commit and LGPL notice.**

- [ ] **Step 2: Run it and confirm it fails before vendoring.**

- [ ] **Step 3: Add the project as a pinned, recursively initialized submodule and record its commit, license, build instructions, and source URL.**

  Do not modify upstream library code. Retain dynamic linking (`libhyperdht.so`) so Android users can replace/relink it as required by LGPL-3.0.

- [ ] **Step 4: Add the CMake target that builds the required Android ABIs as a shared library and links the JNI adapter.**

  Keep all native build output under Gradle’s ignored build directories. Do not download mutable `main` during builds.

- [ ] **Step 5: Run the provenance test and a CMake/Gradle native configuration task.**

- [ ] **Step 6: Commit the dependency boundary separately.**

### Task 7: Implement the Kotlin/JNI Capacitor peer plugin test-first

**Files:**
- Create: `apps/mobile/android/app/src/main/java/com/lycaonsolutions/t4code/T4PeerPlugin.java`
- Create: `apps/mobile/android/app/src/main/java/com/lycaonsolutions/t4code/PeerInviteValidator.java`
- Create: `apps/mobile/android/app/src/test/java/com/lycaonsolutions/t4code/PeerInviteValidatorTest.java`
- Create: `apps/mobile/android/app/src/main/cpp/t4_peer_jni.cpp`
- Create: `apps/mobile/android/app/src/androidTest/java/com/lycaonsolutions/t4code/T4PeerPluginTest.java`
- Modify: `apps/mobile/android/app/src/main/java/com/lycaonsolutions/t4code/MainActivity.java`
- Modify: `apps/mobile/android/app/build.gradle`

- [ ] **Step 1: Write JVM tests for strict invite validation and plugin state mapping.**

  Cover good invite, malformed/oversize input, authorization failure, no permission for malformed input, connection cancellation, and safe public errors.

- [ ] **Step 2: Run the unit test and confirm it fails for the missing validator.**

- [ ] **Step 3: Implement the validator and Kotlin plugin contract.**

  Capacitor methods: `connect({invite})`, `send({dataBase64})`, `disconnect()`, and `status()`. Events: `peerState`, `peerMessage`, `peerClose`, and `peerError`. Validate before native allocation; bound decoded/encoded payloads to 4 MiB; never include an invite or capability in an event/error.

- [ ] **Step 4: Implement JNI ownership and callbacks.**

  A dedicated native event-loop thread owns `hyperdht-cpp`. It connects using the desktop public key, runs the Chunk 1 challenge-response protocol, converts only authorized `message` frames into Capacitor events, and frees all DHT/socket resources on disconnect, activity destruction, or callback failure.

- [ ] **Step 5: Register the plugin and run JVM tests until green.**

  Run: `./gradlew :app:testDebugUnitTest`

- [ ] **Step 6: Add an instrumented loopback/JNI lifecycle test, run it on an emulator or attached device, and commit.**

  Run: `./gradlew :app:connectedDebugAndroidTest`

## Chunk 4: Mobile UI and transport adapter

### Task 8: Add the web-side native peer transport

**Files:**
- Create: `apps/web/src/platform/peer-transport.ts`
- Create: `apps/web/test/peer-transport.test.ts`
- Modify: `apps/web/src/platform/native-mobile.ts`
- Modify: `apps/web/src/platform/browser-shell-port.ts`

- [ ] **Step 1: Write failing tests against a fake Capacitor peer plugin.**

  Verify `OmpTransport` message ordering, base64 conversion, 4 MiB rejection, close/error delivery, listener cleanup, and no attempt to instantiate `WebSocket` for a peer backend.

- [ ] **Step 2: Run the focused test and confirm the peer transport is absent.**

- [ ] **Step 3: Implement `CapacitorPeerTransport` and a tagged mobile backend configuration.**

  Keep existing Tailnet storage/version behavior intact. Peer invite state is kept only in memory during setup; clear it after failure or disconnect.

- [ ] **Step 4: Update the browser shell port to choose WebSocket only for Tailnet and `CapacitorPeerTransport` only for Android peer mode.**

- [ ] **Step 5: Re-run focused tests and the web typecheck.**

- [ ] **Step 6: Commit the transport adapter.**

### Task 9: Add paste and QR scan to the Android connection screen

**Files:**
- Modify: `apps/web/src/components/MobileConnectionScreen.tsx`
- Modify: `apps/web/test/native-mobile.test.tsx`
- Create: `apps/mobile/android/app/src/main/java/com/lycaonsolutions/t4code/T4QrScannerPlugin.java` (or a pinned Capacitor-compatible scanner plugin integration)
- Modify: `apps/mobile/android/app/src/main/AndroidManifest.xml`
- Modify: `apps/mobile/android/app/build.gradle`
- Modify: `apps/mobile/android/app/src/main/java/com/lycaonsolutions/t4code/MainActivity.java`

- [ ] **Step 1: Write failing UI tests for the connection-method selector.**

  Assert Tailnet remains available, peer-key paste accepts only valid invites, scan requests camera access only after the user taps scan, scan populates the same validation path, and errors never echo a key.

- [ ] **Step 2: Run the focused test and confirm it fails.**

- [ ] **Step 3: Implement a native CameraX/ML Kit QR scanner plugin or a pinned Capacitor-8-compatible scanner plugin.**

  Request `CAMERA` at runtime, restrict accepted contents to `t4peer://v1/`, return one scan result to the WebView, and stop the camera immediately. Add `android.permission.CAMERA`; do not grant unrelated media permissions.

- [ ] **Step 4: Implement the two-method UI.**

  The peer route has Paste and Scan actions, visible connecting state, cancel, and an accessible non-camera paste fallback. On successful native authorization, set the in-memory peer backend and reload/boot the existing client; on failure, stay on setup with safe guidance.

- [ ] **Step 5: Run web tests and Android unit tests.**

- [ ] **Step 6: Commit the mobile connection UI.**

## Chunk 5: Integration, documentation, and release verification

### Task 10: Add cross-implementation interoperability coverage

**Files:**
- Create: `apps/desktop/test/peer-interoperability.test.ts`
- Create: `apps/mobile/android/app/src/androidTest/java/com/lycaonsolutions/t4code/PeerInteropTest.java`
- Modify: `scripts/check-provenance.mjs`
- Modify: `scripts/check-provenance.test.mjs`

- [ ] **Step 1: Write a failing desktop integration test that starts the JS host and verifies an authorized framed connection can relay an OMP fixture WebSocket message.**

- [ ] **Step 2: Run it and confirm it fails before the bridge is complete.**

- [ ] **Step 3: Implement only the test harness/configuration required to make the existing bridge pass.**

- [ ] **Step 4: Add an Android instrumented test using the same fixture and pinned native library.**

- [ ] **Step 5: Run both test layers and commit.**

### Task 11: Document operation and verify distributables

**Files:**
- Create: `docs/PEER_REMOTE.md`
- Modify: `docs/TAILNET_REMOTE.md`
- Modify: `README.md`
- Modify: `THIRD_PARTY_NOTICES.md`

- [ ] **Step 1: Write docs tests/checks that require no capability strings in examples, logs, or release metadata.**

- [ ] **Step 2: Document desktop sharing, Android paste/scan, expiry/revocation, restrictive-network behavior, Tailnet coexistence, privacy, and LGPL notices.**

- [ ] **Step 3: Run final verification from a clean dependency install.**

  Run:
  ```bash
  corepack pnpm install --frozen-lockfile
  pnpm test
  pnpm check
  pnpm --filter @t4-code/desktop build
  pnpm --filter @t4-code/mobile build:android:debug
  ```

- [ ] **Step 4: Perform the physical-device acceptance check.**

  Start a desktop share, scan its QR on Android, verify one OMP session list and one non-destructive command round-trip, regenerate the key, and verify the old mobile connection closes.

- [ ] **Step 5: Commit documentation and report the exact desktop artifact and APK paths.**

---

## Execution constraints

- Apply TDD per task: run every new test red before production implementation, then green before moving on.
- Do not weaken `allowMixedContent: false`, local-only gateway binding, sender validation, or existing Tailnet origin validation.
- Never print an invite capability in terminal output, test failure text, desktop IPC event, analytics, or persisted storage.
- Stop and request direction if `hyperdht-cpp` cannot produce a dynamic Android shared library for the required ABIs, if its wire compatibility fails against the pinned JavaScript version, or if the required license/provenance material cannot be packaged.
