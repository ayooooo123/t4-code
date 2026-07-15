# Direct Mobile Workspaces Implementation Plan

> **For agentic workers:** REQUIRED: Use `superpowers:executing-plans` to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Provide a reliable direct-phone pairing flow and let desktop or an authenticated direct mobile peer select approved workspace roots and create project folders beneath the active root.

**Architecture:** Keep OMP traffic on the existing authenticated HyperDHT stream. Add a narrow, versioned workspace-control channel to that same authorized stream, backed by a desktop-only workspace service that canonicalizes filesystem paths and persists approved roots. Desktop uses the service through Electron IPC; Android uses it only over the authenticated direct stream.

**Tech Stack:** Electron IPC and `safeStorage`, Node `fs/promises` and `path`, React/TypeScript, Capacitor ML Kit barcode scanning, HyperDHT peer wire protocol, Vite Plus tests, Android Gradle.

---

## File map

- Create `apps/desktop/src/workspace-roots.ts`: canonical root/project service, persistence adapter, safe project IDs, and filesystem validation.
- Create `apps/desktop/test/workspace-roots.test.ts`: deterministic filesystem-backed service tests.
- Modify `apps/desktop/src/stores.ts`: encrypted desktop persistence for approved root records.
- Modify `apps/desktop/src/lifecycle.ts`: construct one workspace service and inject it into IPC and peer host.
- Modify `apps/desktop/src/ipc.ts`, `apps/desktop/src/preload.ts`, and `packages/protocol/src/desktop-ipc.ts`: trusted local workspace IPC surface.
- Modify `packages/protocol/src/peer-wire.ts` and `packages/protocol/test/peer-wire.test.ts`: strict workspace request/response frames.
- Modify `apps/desktop/src/peer-share.ts` and `apps/desktop/test/peer-share.test.ts`: authorize, serialize, and serve direct workspace controls before proxying OMP messages.
- Modify `apps/web/src/platform/peer-transport.ts` and its tests: direct peer workspace RPC sharing the authenticated stream protocol.
- Modify `apps/web/src/platform/browser-shell-port.ts`: expose workspace actions to the existing mobile/desktop UI controller.
- Create `apps/web/src/features/workspaces/workspace-api.ts` and tests: one UI-facing API for local Electron and peer-backed calls.
- Create `apps/web/src/components/WorkspaceDialog.tsx` and tests: approved-root selector and new-project dialog.
- Modify `apps/web/src/components/Rail.tsx`: workspace action entry point and immediate empty-project groups.
- Modify `apps/web/src/components/PeerShareAction.tsx` and tests: explicit direct connection status and safer reset confirmation.
- Modify `apps/web/src/platform/native-mobile.ts`, `apps/web/src/components/MobileConnectionScreen.tsx`, and tests: scanner capability/error states plus paste fallback.
- Modify `apps/mobile/scripts/prepare-web.test.mjs`: assert Capacitor's generated Android plugin map contains the barcode scanner and the manifest retains `CAMERA`.

## Chunk 1: Host-owned workspace service and local IPC

### Task 1: Build the workspace-root domain service

**Files:**
- Create: `apps/desktop/src/workspace-roots.ts`
- Create: `apps/desktop/test/workspace-roots.test.ts`

- [ ] **Step 1: Write failing tests for canonical root persistence.**

  Cover: an existing directory is accepted; a file/missing path is rejected; duplicate canonical roots collapse; setting an inactive approved root changes only `activeRootId`; an empty configuration has no active root.

- [ ] **Step 2: Run the focused test and verify it fails.**

  Run: `pnpm --filter @t4-code/desktop test -- workspace-roots.test.ts`

- [ ] **Step 3: Implement the minimal service.**

  Define `WorkspaceRoot`, `WorkspaceProject`, and `WorkspaceRootsStore`. Use `realpath`, `lstat`, and a stable opaque root/project ID. Return only display-safe labels and IDs; retain canonical absolute paths privately.

- [ ] **Step 4: Add failing path-boundary tests.**

  Assert `createProject("../escape")`, absolute names, separators, empty names, and a symlink escaping the root all fail. Assert a safe single segment creates exactly one directory under the active root.

- [ ] **Step 5: Implement project creation.**

  Validate a single safe segment, resolve it from the active canonical root, reject existing non-directories, create the directory with mode `0700`, and return an opaque project ID plus relative display name.

- [ ] **Step 6: Re-run focused tests and commit.**

  Run: `pnpm --filter @t4-code/desktop test -- workspace-roots.test.ts`

  Commit: `feat: add approved workspace roots`

### Task 2: Persist roots and expose trusted desktop IPC

**Files:**
- Modify: `apps/desktop/src/stores.ts`
- Modify: `apps/desktop/src/lifecycle.ts`
- Modify: `apps/desktop/src/ipc.ts`
- Modify: `apps/desktop/src/preload.ts`
- Modify: `packages/protocol/src/desktop-ipc.ts`
- Modify: `packages/protocol/test/desktop-ipc.test.ts`
- Modify: `apps/desktop/test/ipc-lifecycle.test.ts`

- [ ] **Step 1: Write failing protocol tests.**

  Add exact request/response schemas for `workspace.roots.list`, `workspace.root.select`, and `workspace.project.create`. Reject extra properties, non-string IDs, unsafe project names, and untrusted Electron senders.

- [ ] **Step 2: Run the protocol and IPC tests to observe failure.**

  Run: `pnpm --filter @t4-code/protocol test -- desktop-ipc.test.ts && pnpm --filter @t4-code/desktop test -- ipc-lifecycle.test.ts`

- [ ] **Step 3: Implement storage and IPC.**

  Store the approved-root record encrypted alongside existing desktop secrets. Inject one `WorkspaceRootsService` through lifecycle into `DesktopIpcRegistry`; expose only the typed, validated operations through preload.

- [ ] **Step 4: Re-run the focused tests and commit.**

  Commit: `feat: expose workspace roots to desktop UI`

## Chunk 2: Direct peer workspace controls

### Task 3: Extend the authenticated peer protocol

**Files:**
- Modify: `packages/protocol/src/peer-wire.ts`
- Modify: `packages/protocol/test/peer-wire.test.ts`
- Modify: `apps/desktop/src/peer-share.ts`
- Modify: `apps/desktop/test/peer-share.test.ts`

- [ ] **Step 1: Write failing peer-wire tests.**

  Add outer frames `workspace-request` and `workspace-response`, carrying a request ID and exactly one of the three typed workspace operations. Verify unknown operation names, duplicate/extra fields, malformed IDs, and oversized fields fail decoding.

- [ ] **Step 2: Run peer-wire tests and verify RED.**

  Run: `pnpm --filter @t4-code/protocol test -- peer-wire.test.ts`

- [ ] **Step 3: Implement strict frame codecs.**

  Keep workspace frames separate from OMP `message` frames. They must be usable only after `authorized` and preserve the existing 4 MiB frame bound.

- [ ] **Step 4: Write failing peer-host tests.**

  Cover: unauthenticated workspace request closes the stream; authorized roots list succeeds; root selection and project creation use the injected service; a workspace request never creates an upstream OMP transport; requests remain serialized.

- [ ] **Step 5: Implement peer-host dispatch.**

  Inject a `WorkspaceRootsService` into `PeerShareHost`, dispatch only after capability authorization, and encode bounded error responses. Do not add a network endpoint, relay, or command execution path.

- [ ] **Step 6: Run tests and commit.**

  Run: `pnpm --filter @t4-code/protocol test -- peer-wire.test.ts && pnpm --filter @t4-code/desktop test -- peer-share.test.ts`

  Commit: `feat: manage workspaces over direct peer links`

### Task 4: Add mobile peer workspace RPC

**Files:**
- Modify: `apps/web/src/platform/peer-transport.ts`
- Modify: `apps/web/test/peer-transport.test.ts`
- Modify: `apps/web/src/platform/browser-shell-port.ts`
- Modify: `apps/web/test/browser-shell-port.test.ts`

- [ ] **Step 1: Write failing transport tests.**

  Build a fake native plugin session and assert an authorized workspace request resolves its matching response, ignores other request IDs, rejects error responses, and cleans up listeners/stream on completion.

- [ ] **Step 2: Run the transport test and verify RED.**

  Run: `pnpm --filter @t4-code/web test -- peer-transport.test.ts`

- [ ] **Step 3: Implement a bounded workspace RPC helper.**

  Reuse the existing invite authentication and native stream primitives, but create a short-lived authenticated control stream. Never use it for OMP frames and never expose a raw host path to the UI.

- [ ] **Step 4: Expose the same typed workspace methods from browser shell.**

  For a peer invite, delegate to the RPC helper. For a normal web backend, return the existing unsupported-state error. Keep the desktop-local implementation in preload IPC.

- [ ] **Step 5: Re-run focused tests and commit.**

  Commit: `feat: control approved roots from mobile`

## Chunk 3: Pairing and workspace UX

### Task 5: Make direct phone pairing legible and scanner failures actionable

**Files:**
- Modify: `apps/web/src/components/PeerShareAction.tsx`
- Create: `apps/web/test/peer-share-action.test.tsx`
- Modify: `apps/web/src/platform/native-mobile.ts`
- Modify: `apps/web/src/components/MobileConnectionScreen.tsx`
- Modify: `apps/web/test/native-mobile.test.tsx`
- Modify: `apps/mobile/scripts/prepare-web.test.mjs`

- [ ] **Step 1: Write failing component tests.**

  Assert desktop renders **Connect phone**, reports preparing/ready/error states, requires confirmation before resetting a pairing, and never renders the capability as a status value. Assert Android shows **Scan desktop QR** first, paste-key second, and a denied/unavailable scanner leaves paste usable.

- [ ] **Step 2: Verify tests fail.**

  Run: `pnpm --filter @t4-code/web test -- peer-share-action.test.tsx native-mobile.test.tsx`

- [ ] **Step 3: Implement the UI states and scanner diagnostics.**

  Preserve `BarcodeScanner` auto-registration generated by Capacitor; verify the generated plugin map and manifest in the mobile build test. Surface `isSupported`, permission denial, start failure, and malformed QR as distinct UI messages. Do not add Google Play Services as a dependency.

- [ ] **Step 4: Run focused web/mobile tests and commit.**

  Run: `pnpm --filter @t4-code/web test -- peer-share-action.test.tsx native-mobile.test.tsx && pnpm --filter @t4-code/mobile test`

  Commit: `feat: clarify direct phone pairing`

### Task 6: Add root selection and new-project UI to desktop and mobile

**Files:**
- Create: `apps/web/src/features/workspaces/workspace-api.ts`
- Create: `apps/web/test/workspace-api.test.ts`
- Create: `apps/web/src/components/WorkspaceDialog.tsx`
- Create: `apps/web/test/workspace-dialog.test.tsx`
- Modify: `apps/web/src/components/Rail.tsx`
- Modify: `apps/web/src/lib/workspace-data.ts`
- Modify: `apps/web/src/platform/live-workspace.ts`

- [ ] **Step 1: Write failing API tests.**

  Assert desktop and direct-peer adapters return the same root/project view model; assert a web-only backend is unsupported; assert no adapter returns a raw host path.

- [ ] **Step 2: Write failing UI tests.**

  Cover no-root empty state, selecting an approved root, disabled creation without an active root, validation error retention, successful folder creation, and an empty project appearing in the rail before its first session.

- [ ] **Step 3: Run focused tests and verify RED.**

  Run: `pnpm --filter @t4-code/web test -- workspace-api.test.ts workspace-dialog.test.tsx`

- [ ] **Step 4: Implement the shared UI API and dialog.**

  Add a workspace action beside the rail heading. The dialog shows active root label, approved roots, desktop-only add/remove root controls, and the project-folder form. On mobile the root list is selectable but add/remove controls are absent.

- [ ] **Step 5: Merge empty projects into the rail projection.**

  Keep OMP-derived session groups unchanged, merge locally advertised workspace projects by opaque ID, and preserve existing session creation behavior for an empty project.

- [ ] **Step 6: Run focused tests and commit.**

  Commit: `feat: create projects in approved workspaces`

## Chunk 4: Verification and release artifacts

### Task 7: Verify desktop and Android behavior

**Files:**
- Modify only if tests reveal a defect.

- [ ] **Step 1: Run the complete relevant test suites.**

  Run: `pnpm --filter @t4-code/protocol test && pnpm --filter @t4-code/desktop test && pnpm --filter @t4-code/web test && pnpm --filter @t4-code/mobile test`

- [ ] **Step 2: Build both artifacts.**

  Run: `pnpm --filter @t4-code/desktop package:mac && pnpm --filter @t4-code/mobile build:android:debug`

- [ ] **Step 3: Install the Android debug APK and test scanner behavior on device.**

  Verify the app requests camera permission only after scan is pressed, scan/paste each persist a valid invite, and cancel/deny returns to the same screen. Use a physical Android device for direct HyperDHT pairing; do not treat emulator UDP behavior as a pass/fail of direct connectivity.

- [ ] **Step 4: Exercise workspace flow through both clients.**

  From desktop add/select a root and create a project. From mobile select another approved root and create a second project. Confirm every created directory is below the selected root and no arbitrary path can be submitted.

- [ ] **Step 5: Commit any final fixes and publish artifacts.**

  Commit: `fix: verify direct workspace controls`
