# Persistent HyperDHT Pairing Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep an explicitly paired Android device reconnectable across app relaunches and permit up to four concurrent authorized mobile streams.

**Architecture:** Encrypt and persist one desktop DHT key pair plus pairing capability with Electron safe storage, initialise the DHT listener for the desktop lifecycle, and retain a set of active peer streams. Give each native mobile open operation an attempt ID so timeout/user cancellation can release the native DHT and its state guard before a session exists.

**Tech Stack:** Electron, TypeScript, HyperDHT JavaScript, Capacitor, Kotlin/coroutines, hyperdht-cpp JNI, Vitest, Gradle.

---

## Chunk 1: Persistent desktop pairing

### Task 1: Persist encrypted pairing material

**Files:**
- Modify: `apps/desktop/src/stores.ts`
- Modify: `apps/desktop/test/stores.test.ts`
- Modify: `apps/desktop/src/peer-share.ts`
- Test: `apps/desktop/test/peer-share.test.ts`

- [ ] **Step 1: Write failing store and host tests.**
  Verify encrypted round-trip of exact 32/64/32 byte key material, invalid
  ciphertext rejection, and a restarted host retaining desktop public key and
  accepting the old capability.
- [ ] **Step 2: Run focused tests and confirm the persistence behavior fails.**
  Run: `pnpm --filter @t4-code/desktop test -- stores.test.ts peer-share.test.ts`
- [ ] **Step 3: Implement the minimum encrypted `PeerPairingStore`.**
  Use `safeStorage`; validate decoded byte lengths; do not expose the capability
  through status. Inject the store into `PeerShareHost` so tests stay pure.
- [ ] **Step 4: Re-run focused tests until green.**
- [ ] **Step 5: Commit.**
  Run: `git add apps/desktop/src/stores.ts apps/desktop/src/peer-share.ts apps/desktop/test/stores.test.ts apps/desktop/test/peer-share.test.ts && git commit -m "feat: persist encrypted peer pairing"`

### Task 2: Enable concurrent streams and reset-based revocation

**Files:**
- Modify: `apps/desktop/src/peer-share.ts`
- Modify: `apps/desktop/test/peer-share.test.ts`
- Modify: `apps/web/src/components/PeerShareAction.tsx`

- [ ] **Step 1: Write failing tests for four simultaneous authorized sockets, fifth-socket rejection, and reset revocation.**
- [ ] **Step 2: Run the peer-host test and confirm the old one-stream logic fails.**
  Run: `pnpm --filter @t4-code/desktop test -- peer-share.test.ts`
- [ ] **Step 3: Replace `activeStream` with a stream set and enforce `MAX_ACTIVE_STREAMS = 4`.**
  Keep independent OMP transport ownership and destroy all streams on reset/
  stop. Generate a new capability only on explicit reset.
- [ ] **Step 4: Update desktop language from expiring one-phone sharing to persistent pairing and reset.**
- [ ] **Step 5: Re-run focused tests and commit.**
  Run: `git add apps/desktop/src/peer-share.ts apps/desktop/test/peer-share.test.ts apps/web/src/components/PeerShareAction.tsx && git commit -m "feat: allow concurrent persistent peer streams"`

### Task 3: Start the listener as part of desktop lifecycle

**Files:**
- Modify: `apps/desktop/src/lifecycle.ts`
- Modify: `apps/desktop/test/lifecycle-runtime.test.ts`
- Modify: `apps/desktop/src/ipc.ts`
- Modify: `apps/desktop/test/ipc-lifecycle.test.ts`

- [ ] **Step 1: Write a lifecycle test that initialises the persistent host before renderer IPC and stops it on teardown.**
- [ ] **Step 2: Run the focused desktop lifecycle tests and confirm failure.**
- [ ] **Step 3: Inject a persistent peer-host factory; initialise it after Electron is ready and before the renderer loads.**
- [ ] **Step 4: Re-run tests and commit.**

## Chunk 2: Cancellable, reconnectable mobile lifecycle

### Task 4: Add native open cancellation

**Files:**
- Modify: `apps/web/src/platform/native-mobile.ts`
- Modify: `apps/web/src/platform/peer-transport.ts`
- Modify: `apps/web/test/peer-transport.test.ts`
- Modify: `apps/mobile/android/app/src/main/kotlin/com/lycaonsolutions/t4code/T4PeerConnectionPlugin.kt`
- Modify: `apps/mobile/scripts/prepare-web.test.mjs`

- [ ] **Step 1: Write a failing web transport test that timeout calls `cancelOpen` with the generated attempt ID, removes listeners, and permits retry.**
- [ ] **Step 2: Run the focused test and confirm failure.**
  Run: `pnpm --filter @t4-code/web test -- peer-transport.test.ts`
- [ ] **Step 3: Extend the Capacitor API with `attemptId` and `cancelOpen`.**
  Native tracks its opening job/DHT by ID, cancels it, wakes the DHT loop, and
  clears the guard before completing the cancellation request.
- [ ] **Step 4: Re-run focused web/native source tests until green and commit.**

### Task 5: Make native close wake an idle libuv loop

**Files:**
- Modify: `third_party/hyperdht-cpp/wrappers/kotlin/src/main/kotlin/com/hyperdht/HyperDHT.kt`
- Modify: `apps/mobile/scripts/prepare-web.test.mjs`
- Test: Android compile/assemble tasks

- [ ] **Step 1: Add a failing source-level regression check for native-loop wake before `cancelAndJoin`.**
- [ ] **Step 2: Run the check and confirm failure.**
- [ ] **Step 3: Wake `asyncHandle` from `close()` before waiting for the loop job, retaining normal close order afterward.**
- [ ] **Step 4: Run source tests, Kotlin compile, and APK assembly; commit.**

## Chunk 3: Verify and package

### Task 6: Full regression and device smoke test

**Files:**
- Modify: `docs/PEER_REMOTE.md` if needed for persistent/reset semantics

- [ ] **Step 1: Run desktop and web suites plus typechecks.**
- [ ] **Step 2: Build desktop main/preload bundles and Android debug APK.**
- [ ] **Step 3: Install APK on emulator, verify launch/close/relaunch with no crash, and capture safe logs.**
- [ ] **Step 4: Copy the verified APK to the user output directory and commit final documentation.**
