# Mobile Host Directory v3 Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Introduce a strictly validated v3 logical-host directory, migrate recoverable v1/v2 connections and legacy secure credentials without loss, and keep the application working through an explicit first-preferred-method compatibility projection.

**Architecture:** Pure connection parsing, pure v3 schema validation, and storage transactions live in separate modules with one-way dependencies. Migration verifies exact v3 bytes before removing v2 metadata and deliberately retains legacy metadata until Capacitor has migrated its unscoped credential to that legacy record's canonical Tailnet scope. Native boot projects only the active host's first preferred method into the current single-route shell; ordered fallback and multi-method editing are separate reviewed plans.

**Tech Stack:** TypeScript, Vitest/Vite Plus, Capacitor secure storage, browser WebSocket, native HyperDHT peer transport, localStorage.

**Design source:** `docs/superpowers/specs/2026-07-16-extensible-remote-transports-design.md`

---

## Chunk 1: Pure connection records and v3 schema

### Task 1: Extract exact connection-record parsing

**Files:**
- Create: `apps/web/src/platform/mobile-connection-records.ts`
- Create: `apps/web/test/mobile-connection-records.test.ts`
- Modify: `apps/web/src/platform/native-mobile.ts`
- Modify: `apps/web/src/platform/mobile-qr-scanner.ts`
- Modify: `apps/web/src/components/MobileConnectionScreen.tsx`
- Modify: `apps/web/src/components/MobileQrScannerFlow.tsx`
- Modify: `apps/web/test/native-mobile.test.tsx`
- Modify: `apps/web/test/mobile-qr-scanner.test.ts`
- Modify: `apps/web/test/mobile-qr-scanner-ui.test.tsx`

The neutral module exports the existing record types and parsers plus:

```ts
export function peerDesktopPublicKey(invite: string): string;
export function peerDesktopFingerprint(invite: string): string;
```

`peerDesktopPublicKey` returns the decoded 32-byte public key in canonical unpadded base64url (43 characters). `peerDesktopFingerprint` returns its first eight base64url characters. For the fixed acceptance invite both return `AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA` and `AAAAAAAA`. The current 16-character grouped confirmation fingerprint remains a UI-only formatter and is not the persisted schema fingerprint.

- [ ] **Step 1: Write and run RED Tailnet parser tests**

Add one success test for `Desk.TAILNET.ts.net:8445` producing canonical origin `https://desk.tailnet.ts.net:8445`, `wss://desk.tailnet.ts.net:8445/v1/ws`, and label `T4 on desk`. Add a table rejecting empty/over-2,048 characters, HTTP, credentials, path/query/fragment, bare `ts.net`, non-Tailnet hosts, and labels over 128 characters.

Run: `pnpm --filter @t4-code/web test -- mobile-connection-records.test.ts`

Expected: FAIL because the module is missing.

- [ ] **Step 2: Move the Tailnet parser and run GREEN**

Move `StoredMobileBackend`, `MobileConnectionUserError`, `parseTailnetBackend`, and their constants. The module imports no native bridge and touches no window/storage. Re-export from `native-mobile.ts` only for existing callers.

Run: `pnpm --filter @t4-code/web test -- mobile-connection-records.test.ts native-mobile.test.tsx`

Expected: PASS.

- [ ] **Step 3: Write and run RED peer parser tests**

Use the fixed public invite. Assert trim/canonical value, label, literal public-key identity/fingerprint above, and `MobileConnectionUserError` for every rejection. Bound the **raw input before trim or parsing** with `new TextEncoder().encode(value).byteLength <= 2_048`; include both a multibyte string whose UTF-16 length is at most 2,048 but UTF-8 length exceeds it and over-2,048 bytes of surrounding whitespace plus an otherwise valid invite. Reject wrong scheme/version/key/capability lengths. Assert error messages contain no input, invite, capability, or native decoder text.

Run: `pnpm --filter @t4-code/web test -- mobile-connection-records.test.ts`

Expected: FAIL on missing peer exports and current UTF-16 bound/error class.

- [ ] **Step 4: Move peer parsing/helpers and run GREEN**

Move `StoredPeerMobileBackend`, `StoredMobileConnection`, `parsePeerBackend`, and implement the two exact helpers. Update direct imports; keep the existing UI-only 16-character grouped preview and its tests unchanged.

Run:

```bash
pnpm --filter @t4-code/web test -- mobile-connection-records.test.ts native-mobile.test.tsx mobile-qr-scanner.test.ts mobile-qr-scanner-ui.test.tsx
pnpm --filter @t4-code/web typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/platform/mobile-connection-records.ts apps/web/test/mobile-connection-records.test.ts apps/web/src/platform/native-mobile.ts apps/web/src/platform/mobile-qr-scanner.ts apps/web/src/components/MobileConnectionScreen.tsx apps/web/src/components/MobileQrScannerFlow.tsx apps/web/test/native-mobile.test.tsx apps/web/test/mobile-qr-scanner.test.ts apps/web/test/mobile-qr-scanner-ui.test.tsx
git commit -m "refactor: isolate mobile connection records"
```

### Task 2: Parse the v3 directory structure exactly

**Files:**
- Create: `apps/web/src/platform/mobile-host-schema.ts`
- Create: `apps/web/test/mobile-host-schema.test.ts`
- Modify: `apps/web/src/platform/native-mobile.ts`
- Modify: `apps/web/test/native-mobile.test.tsx`

Schema rules:

- Exact allowed-key sets at every object level; unknown keys reject.
- IDs match `/^[A-Za-z0-9_-]{16,64}$/u`.
- Labels are 1–128 UTF-16 code units, equal `.trim()`, and contain no U+0000–U+001F/U+007F.
- One to 16 hosts; one or two transports per host; at most one transport of each kind.
- One global ID namespace: host IDs and transport IDs are all unique, including cross-kind collision.
- `activeHostId` names a host. Each `preferredTransportIds` is an exact duplicate-free permutation of that host's transport IDs.
- Canonical identities are globally unique: `tailscale:<canonical origin>`; `hyperdht:<full canonical public key>`. Different capabilities for one public key collide.
- Parsed values and every nested object/array are recursively frozen.
- `lastConnection.at` is an integer from 0 through `Number.MAX_SAFE_INTEGER`; kind must exist on the host; outcome is `connected | unavailable | auth | protocol | cancelled`.

Tailscale exact record:

```ts
{ id, kind: "tailscale", origin, wsUrl, displayAddress, credentialScopeKey }
```

All four routing/scope values must equal `parseTailnetBackend(origin)`'s canonical origin/wsUrl/origin/origin.

HyperDHT exact record:

```ts
{ id, kind: "hyperdht", invite, desktopFingerprint }
```

The invite must parse and fingerprint must equal `peerDesktopFingerprint(invite)`.

- [ ] **Step 1: Write and run RED top-level/host structural tests**

Test null/array/wrong version; an extra key separately at top-level, host, Tailscale transport, HyperDHT transport, and `lastConnection`; zero/17 hosts; missing active host; invalid IDs; label trim/control/length; zero/3 transports; and invalid last-connection fields.

Run: `pnpm --filter @t4-code/web test -- mobile-host-schema.test.ts`

Expected: FAIL because `parseMobileHostDirectory` is missing.

- [ ] **Step 2: Implement top-level/host structure and run GREEN**

Create types plus `parseMobileHostDirectory(value)` and `activeMobileHost(directory)`. Controlled `StoredMobileDirectoryError` never includes raw values.

Run: `pnpm --filter @t4-code/web test -- mobile-host-schema.test.ts`

Expected: structural tests PASS.

- [ ] **Step 3: Write and run RED ID/preference invariant tests**

Separate named cases: duplicate host IDs; duplicate transport IDs across hosts; host ID collides with transport ID; duplicate/missing/foreign preferred IDs; duplicate transport kind in one host.

Run: `pnpm --filter @t4-code/web test -- mobile-host-schema.test.ts`

Expected: FAIL on each new invariant.

- [ ] **Step 4: Implement ID/preference invariants and run GREEN**

Run: `pnpm --filter @t4-code/web test -- mobile-host-schema.test.ts`

Expected: PASS.

- [ ] **Step 5: Write and run RED canonical transport tests**

Test every Tailnet equality, invalid invite, forged fingerprint, duplicate canonical Tailnet origin across hosts, same peer public key/different capability across hosts, exact canonical identity strings, and recursive freezing.

Run: `pnpm --filter @t4-code/web test -- mobile-host-schema.test.ts`

Expected: FAIL on canonical transport validation.

- [ ] **Step 6: Implement canonical transports/freeze and run GREEN**

Export `canonicalTransportIdentity(transport)`; implement recursive freeze.

Run:

```bash
pnpm --filter @t4-code/web test -- mobile-host-schema.test.ts mobile-connection-records.test.ts
pnpm --filter @t4-code/web typecheck
```

Expected: PASS.

- [ ] **Step 7: Move the v3 key to its single owner and commit**

Export `MOBILE_HOST_DIRECTORY_STORAGE_KEY = "t4-code:mobile-hosts:v3"` only from `mobile-host-schema.ts`. Remove its declaration from `native-mobile.ts` and import/re-export it there for compatibility. Update the first-run ownership tests.

Run: `pnpm --filter @t4-code/web test -- mobile-host-schema.test.ts native-mobile.test.tsx`

Expected: PASS with one declaration found by `rg -n 'mobile-hosts:v3' apps/web/src`.

```bash
git add apps/web/src/platform/mobile-host-schema.ts apps/web/test/mobile-host-schema.test.ts apps/web/src/platform/native-mobile.ts apps/web/test/native-mobile.test.tsx
git commit -m "feat: define mobile host directory v3"
```

### Task 3: Add bounded v3 storage I/O

**Files:**
- Create: `apps/web/src/platform/mobile-host-storage.ts`
- Create: `apps/web/test/mobile-host-storage.test.ts`

- [ ] **Step 1: Write and run RED read tests**

Test absent key -> null; valid canonical JSON -> frozen directory; corrupt JSON, invalid schema, and throwing `getItem` -> controlled `StoredMobileDirectoryError` with no raw text/key value.

Run: `pnpm --filter @t4-code/web test -- mobile-host-storage.test.ts`

Expected: FAIL because `readMobileHostDirectory` is missing.

- [ ] **Step 2: Implement read and run GREEN**

Run: `pnpm --filter @t4-code/web test -- mobile-host-storage.test.ts`

Expected: PASS.

- [ ] **Step 3: Write and run RED write tests**

Test invalid input rejects before `setItem`; valid input serializes the parsed canonical frozen directory exactly once; a throwing `setItem` maps to controlled error; no error contains invite/origin/raw JSON.

Run: `pnpm --filter @t4-code/web test -- mobile-host-storage.test.ts`

Expected: FAIL because `writeMobileHostDirectory` is missing.

- [ ] **Step 4: Implement write, run GREEN, and commit**

```ts
export function readMobileHostDirectory(storage?: Pick<Storage, "getItem">): MobileHostDirectory | null;
export function writeMobileHostDirectory(directory: MobileHostDirectory, storage?: Pick<Storage, "setItem">): void;
```

Run:

```bash
pnpm --filter @t4-code/web test -- mobile-host-storage.test.ts mobile-host-schema.test.ts
pnpm --filter @t4-code/web typecheck
git diff --check
```

Expected: PASS.

```bash
git add apps/web/src/platform/mobile-host-storage.ts apps/web/test/mobile-host-storage.test.ts
git commit -m "feat: persist mobile host directory v3"
```

## Chunk 2: Transactional migration, credential provenance, and working boot

### Task 4: Build deterministic migration candidates

**Files:**
- Modify: `apps/web/src/platform/mobile-host-storage.ts`
- Modify: `apps/web/test/mobile-host-storage.test.ts`
- Modify: `apps/web/src/platform/native-mobile.ts`

Mapping is exact: v2 Tailnet entries retain order and active origin; standalone v2 peer becomes one active peer host; distinct valid legacy Tailnet appends after v2; duplicate legacy origin emits nothing; v2 peer plus legacy produces peer active then Tailnet; legacy alone is active. Hosts are never merged across transport kinds. Any present corrupt source returns repair and writes nothing.

`nextId(kind)` is called host then transport for each emitted host and every returned ID is schema-validated. Invalid, duplicate, or throwing IDs return controlled repair without leaked exception text.

- [ ] **Step 1: Write and run RED source-mapping tests**

Use literal deterministic IDs. Assert exact directories for legacy only; two-entry v2 Tailnet with second active; duplicate legacy+v2; distinct legacy+v2; v2 peer only; v2 peer+legacy; empty; corrupt legacy+valid v2; corrupt v2+valid legacy. Assert source bytes unchanged.

Run: `pnpm --filter @t4-code/web test -- mobile-host-storage.test.ts`

Expected: FAIL because `buildMobileHostMigration` is missing.

- [ ] **Step 2: Implement mapping and run GREEN**

Run: `pnpm --filter @t4-code/web test -- mobile-host-storage.test.ts native-mobile.test.tsx`

Expected: mapping tests PASS.

- [ ] **Step 3: Write and run RED ID-factory failures**

Test invalid grammar, duplicate host IDs, host/transport collision, duplicate transports, and throw. Assert repair, unchanged sources, controlled message.

Run: `pnpm --filter @t4-code/web test -- mobile-host-storage.test.ts`

Expected: FAIL on new cases.

- [ ] **Step 4: Validate generated candidates, run GREEN, and commit**

Export a pure `buildMobileHostMigration({legacyRaw,v2Raw}, nextId)` returning empty/candidate/repair.

Run:

```bash
pnpm --filter @t4-code/web test -- mobile-host-storage.test.ts native-mobile.test.tsx
pnpm --filter @t4-code/web typecheck
```

Expected: PASS.

```bash
git add apps/web/src/platform/mobile-host-storage.ts apps/web/test/mobile-host-storage.test.ts apps/web/src/platform/native-mobile.ts
git commit -m "feat: build deterministic mobile host migrations"
```

### Task 5: Prepare a raw-byte-owned migration without mutating storage

**Files:**
- Modify: `apps/web/src/platform/mobile-host-storage.ts`
- Modify: `apps/web/test/mobile-host-storage.test.ts`

Preparation is read-only:

1. Read v3/v2/legacy; read throw -> repair, no mutation.
2. A valid existing v3 returns `existing` and performs no source parsing, secure migration, write, or removal. An invalid existing v3 returns repair and preserves every byte.
3. With no v3, build/validate the candidate and serialize once to `candidateRaw`.
4. Return an internal pending object containing the exact observed `v2Raw`, `legacyRaw`, candidate bytes/directory, and parsed legacy origin when present. Raw fields never cross UI/log/JSON boundaries.

- [ ] **Step 1: Write and run RED transaction tests**

Assert zero mutations and exact results for existing valid/corrupt v3, empty sources, each migration fixture, throwing reads, and valid v3 coexisting with both matching and unrelated valid legacy bytes. Existing-v3 cases must make no legacy provenance available.

Run: `pnpm --filter @t4-code/web test -- mobile-host-storage.test.ts`

Expected: FAIL because `prepareMobileHostDirectoryLoad` is missing.

- [ ] **Step 2: Implement transaction and run GREEN**

Export existing/empty/pending/repair internally to native boot. All messages are controlled constants; raw source fields stay in a module-private pending type and are never enumerable in a public boot result.

Run:

```bash
pnpm --filter @t4-code/web test -- mobile-host-storage.test.ts
pnpm --filter @t4-code/web typecheck
git diff --check
```

Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/platform/mobile-host-storage.ts apps/web/test/mobile-host-storage.test.ts
git commit -m "feat: prepare mobile host metadata migration"
```

### Task 6: Migrate credentials first, then commit exact v3 bytes

**Files:**
- Modify: `apps/web/src/platform/native-mobile.ts`
- Modify: `apps/web/test/native-mobile.test.tsx`
- Modify: `apps/web/src/platform/mobile-host-storage.ts`
- Modify: `apps/web/test/mobile-host-storage.test.ts`

- [ ] **Step 1: Write and run RED credential-provenance tests**

Cases: v1-only credential migrates to its canonical origin before any metadata write/removal; v2 active plus different legacy migrates only to legacy origin; peer active plus legacy still migrates legacy scope; every native plugin absence/failure leaves v1/v2/v3 bytes unchanged for retry; credentials returned for inactive legacy are not put on the active connection; no wrong-scope clear occurs. Outcome is explicit by selected method: pending HyperDHT boots ready even when the secure plugin is absent/fails; pending Tailscale with an absent plugin returns controlled repair; pending Tailscale with a present plugin whose legacy migration read fails may boot without migrated credentials while preserving every source byte for retry. Pre-existing v3 plus matching or unrelated legacy must make zero migration secure calls and zero source removals.

Add transaction cases after successful secure migration: source compare-and-swap mismatch before v3 write; `setItem` throw before/after exact write; exact valid read-back; missing read-back; mismatched valid/invalid other-writer bytes preserved; owned candidate removed only after fresh exact comparison on failed verification; v2 removal throw returns ready with verified v3; legacy removal throw returns ready with verified v3; relaunch from either partial cleanup state treats v3 as authoritative and removes nothing.

Run: `pnpm --filter @t4-code/web test -- native-mobile.test.tsx mobile-host-storage.test.ts`

Expected: FAIL because secure migration is not ordered before the metadata transaction and commit/finalization functions are missing.

- [ ] **Step 2: Implement native migration and guarded finalization**

For a current pending migration with legacy provenance, call `getCredentials({hostKey: legacyOrigin, migrateLegacy:true})` **before writing v3**. Do not call `clearCredentials` for migration failure. On absence/failure leave storage byte-for-byte unchanged and retry next launch. A selected HyperDHT pending candidate may use its validated in-memory projection without the plugin. A selected Tailscale candidate requires the plugin; when the plugin exists but the migration read fails it may continue without migrated credentials, while plugin absence returns controlled repair. If returned credentials belong to the selected Tailscale scope, reuse them; otherwise discard them from memory after native storage has scoped them.

After secure success (or immediately when no legacy exists), call:

```ts
commitPreparedMobileHostMigration(pending, storage):
  | { kind: "ready"; directory: MobileHostDirectory }
  | { kind: "repair"; message: string };
```

It first compares current v3/v2/legacy bytes to the pending snapshot. Any mismatch refuses without mutation. It writes candidate v3, re-reads exact bytes, parses, and removes owned v3 on failed verification only after a fresh exact comparison. After verified v3 it removes v2 then legacy; removal throws still return ready because v3 is authoritative. A later existing-v3 launch performs no automatic cleanup, exactly as the design requires.

- [ ] **Step 3: Run GREEN and commit**

```bash
pnpm --filter @t4-code/web test -- native-mobile.test.tsx mobile-host-storage.test.ts
pnpm --filter @t4-code/web typecheck
git diff --check
```

Expected: PASS.

```bash
git add apps/web/src/platform/native-mobile.ts apps/web/test/native-mobile.test.tsx apps/web/src/platform/mobile-host-storage.ts apps/web/test/mobile-host-storage.test.ts
git commit -m "feat: migrate mobile hosts after secure credentials"
```

### Task 7: Boot one explicitly preferred v3 method

**Files:**
- Modify: `apps/web/src/platform/native-mobile.ts`
- Modify: `apps/web/src/platform/browser-shell-port.ts`
- Modify: `apps/web/src/main.tsx`
- Modify: `apps/web/test/native-mobile.test.tsx`
- Modify: `apps/web/test/browser-platform.test.ts`

Prepare an in-memory union with local logical `hostId`, label, transport ID, kind, and either Tailscale WS/scope/credentials or HyperDHT invite. Store it only as `window.__t4PreparedMobileConnection`. The local logical host ID is **not** an OMP `hostId`/`expectedHostId`; no server identity is inferred. Multi-method v3 selects exactly `preferredTransportIds[0]` and does not fall back.

- [ ] **Step 1: Write and run RED boot tests**

Cover empty, migrated, valid/corrupt v3, first-preferred Tailscale credential hydration, first-preferred HyperDHT with no secure read, two-method first-only, selected Tailscale credential read failure with controlled credential clearing, missing secure plugin for Tailscale repair, and missing secure plugin for HyperDHT ready.

Run: `pnpm --filter @t4-code/web test -- native-mobile.test.tsx`

Expected: FAIL because v3 is rejected.

- [ ] **Step 2: Implement boot projection and run GREEN**

`prepareNativeMobileBackend` returns ready `{host,directory,connection}` and sets only the new global. First-run still writes v2 in this plan; its next launch migrates v2 to v3. This temporary behavior is explicitly tested and deferred to the UX plan.

Run: `pnpm --filter @t4-code/web test -- native-mobile.test.tsx`

Expected: PASS.

- [ ] **Step 3: Write and run RED shell selection tests**

Assert WebSocket only for prepared Tailscale, native peer only for prepared HyperDHT, non-selected methods unread, credentials persisted only to selected Tailnet scope, logical host ID not passed as expected OMP identity, and old globals ignored.

Run: `pnpm --filter @t4-code/web test -- browser-platform.test.ts`

Expected: FAIL because shell uses old globals.

- [ ] **Step 4: Implement shell consumption, run full GREEN, and commit**

```bash
pnpm --filter @t4-code/web test -- native-mobile.test.tsx browser-platform.test.ts peer-transport.test.ts mobile-host-storage.test.ts mobile-host-schema.test.ts
pnpm --filter @t4-code/web test
pnpm --filter @t4-code/web typecheck
git diff --check
```

Expected: PASS.

```bash
git add apps/web/src/platform/native-mobile.ts apps/web/src/platform/browser-shell-port.ts apps/web/src/main.tsx apps/web/test/native-mobile.test.tsx apps/web/test/browser-platform.test.ts
git commit -m "feat: boot mobile from logical host directory"
```

### Task 8: Bounded inspection, Android build, and honest smoke acceptance

**Files:**
- Modify: `apps/mobile/scripts/inspect-mobile-storage.mjs`
- Modify: `apps/mobile/scripts/inspect-mobile-storage.test.mjs`
- Create: `docs/MOBILE_HOST_DIRECTORY_V3_ACCEPTANCE.md`

V3 bounded output is exactly `{present,version,activeHost,hostCount,transportKinds}`. `activeHost` must be `true`; invalid references reject. `transportKinds` is the sorted unique configured-kind list, maximum two entries. Output never includes IDs, labels, URLs, origins, fingerprints, invites, capabilities, credentials, or raw CDP values.

- [ ] **Step 1: Write/run RED inspector tests, then implement/run GREEN**

Test exact valid output, absent, invalid v3/reference, forbidden shapes, v2 compatibility, thrown/timeout/CDP cleanup, and JSON output absence of fixed invite/origin/IDs.

Run: `node --test apps/mobile/scripts/inspect-mobile-storage.test.mjs`

Expected RED before implementation; PASS after implementation.

- [ ] **Step 2: Run automated gates with pinned runtimes**

```bash
PATH=/Users/jd/.nvm/versions/node/v24.13.1/bin:$PATH pnpm --filter @t4-code/mobile test
PATH=/Users/jd/.nvm/versions/node/v24.13.1/bin:$PATH pnpm --filter @t4-code/web test
PATH=/Users/jd/.nvm/versions/node/v24.13.1/bin:$PATH pnpm --filter @t4-code/web typecheck
JAVA_HOME=/opt/homebrew/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home PATH=/Users/jd/.nvm/versions/node/v24.13.1/bin:$PATH pnpm --filter @t4-code/mobile check:android:debug
JAVA_HOME=/opt/homebrew/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home PATH=/Users/jd/.nvm/versions/node/v24.13.1/bin:$PATH node apps/mobile/scripts/inspect-qr-scanner.mjs apps/mobile/android/app/build/outputs/apk/debug/app-debug.apk
```

Expected: PASS; QR evidence remains CameraX true, bundled decoder true, Play Services scanner path false.

- [ ] **Step 3: Clean install and capture bounded emulator evidence**

```bash
adb -s emulator-5554 uninstall com.lycaonsolutions.t4code
adb -s emulator-5554 install apps/mobile/android/app/build/outputs/apk/debug/app-debug.apk
adb -s emulator-5554 shell pm clear com.lycaonsolutions.t4code
adb -s emulator-5554 logcat -c
adb -s emulator-5554 shell monkey -p com.lycaonsolutions.t4code 1
adb -s emulator-5554 shell uiautomator dump /sdcard/t4-v3-ui.xml
adb -s emulator-5554 pull /sdcard/t4-v3-ui.xml /private/tmp/t4-v3-ui.xml
adb -s emulator-5554 shell pidof com.lycaonsolutions.t4code
adb -s emulator-5554 shell dumpsys activity top
adb -s emulator-5554 logcat -b main -b system -b crash -d -v threadtime -t 2000
```

Assert UI XML contains first-run `Connect to your T4 host` plus Scan/Paste controls, top/resumed activity is `MainActivity`, process exists, and bounded all-buffer logs contain no T4-related fatal exception, CameraAccessException, leaked window/activity, ANR, or unexpected death. Do not claim visual render from launch alone.

- [ ] **Step 4: Record evidence and commit**

Document source commit, `shasum -a 256` APK hash, Pixel_10/API36/arm64, suite/inspector/UI/log results, CDP bounded-v3 status, and physical GrapheneOS `PENDING`. Explicitly mark fallback, multi-method editing, and direct v3 first-run writes deferred.

```bash
git add apps/mobile/scripts/inspect-mobile-storage.mjs apps/mobile/scripts/inspect-mobile-storage.test.mjs docs/MOBILE_HOST_DIRECTORY_V3_ACCEPTANCE.md
git commit -m "docs: verify mobile host directory v3"
git diff --check
git status --short
```

Expected: clean worktree.
