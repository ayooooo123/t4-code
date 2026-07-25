# Multi-Repo OMP Scope and Mobile Sessions Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prepare every selected repository in an isolated worktree, register the complete root set with OMP, and let desktop or a directly paired mobile client launch, reconnect to, and steer the same multi-repo sessions.

**Architecture:** OMP gains a local-UDS-only workspace registry whose opaque ID is accepted by `session.create` and persisted with the session; its RPC runtime receives the same stable alias/root scope on resume. T4 expands the Increment 1 transaction to multiple eager worktrees and projects safe job/review state over strict HyperDHT peer operations. Mobile uses the existing web shell and native direct peer transport; it never receives or submits desktop paths.

**Tech Stack:** Bun/TypeScript OMP app-wire/appserver/coding-agent, TypeScript/Electron T4, HyperDHT typed peer wire, React/Zustand, Capacitor Android, Vite Plus and Bun tests

---

**Spec:** `docs/superpowers/specs/2026-07-16-repository-worktree-mobile-sessions-design.md`

**Prerequisite:** Complete `docs/superpowers/plans/2026-07-16-repository-launcher-single-repo-isolation.md` first.

**Repositories:** T4 paths are relative to this worktree. Paths prefixed **OMP repo** are relative to `/Users/jd/Documents/Codex/omp-t4-runtime`.

## Chunk 1: OMP Multi-Root Authority, Direct Peer Jobs, and Mobile Parity

### Task 1: Define and persist OMP workspace registrations

**Files (OMP repo):**
- Create: `packages/appserver/src/workspace-registry.ts`
- Create: `packages/appserver/test/workspace-registry.test.ts`
- Modify: `packages/appserver/src/types.ts`
- Modify: `packages/appserver/src/index.ts`

- [ ] **Step 1: Write failing registry tests**

Test a versioned private registry with this input shape:

```ts
interface WorkspaceRegistrationInput {
  readonly operationId: string;
  readonly primaryAlias: string;
  readonly roots: readonly {
    alias: string;
    repoId: string;
    canonicalRoot: string;
    baseCommit: string;
    branch: string;
  }[];
}
```

Cover canonical absolute directories, unique sanitized aliases/repo IDs, exactly one primary alias, root-count/field bounds, symlink revalidation, operation-ID idempotency, conflicting replay rejection, durable temp+fsync+rename+directory-fsync writes, restart reload, deregistration only while unused, and no roots in public errors.

- [ ] **Step 2: Run tests and verify failure**

Run from OMP repo: `bun test packages/appserver/test/workspace-registry.test.ts`

Expected: FAIL because `WorkspaceRegistry` is missing.

- [ ] **Step 3: Implement the private registry**

Store registrations under the OMP profile appserver directory with mode `0600`; cap roots at 16 and aliases at 64 bytes. Return random opaque workspace IDs. Keep canonical paths private; expose `register`, `get`, `markSession`, `releaseSession`, `deregisterUnused`, and `recover`.

- [ ] **Step 4: Run tests and appserver typecheck**

Run from OMP repo: `bun test packages/appserver/test/workspace-registry.test.ts && bun --cwd=packages/appserver run build`

Expected: PASS.

- [ ] **Step 5: Commit in the OMP repo**

```bash
git add packages/appserver/src/workspace-registry.ts packages/appserver/test/workspace-registry.test.ts packages/appserver/src/types.ts packages/appserver/src/index.ts
git commit -m "feat(appserver): persist multi-root workspaces"
```

### Task 2: Add a local-admin-only OMP registration endpoint

**Files (OMP repo):**
- Modify: `packages/appserver/src/server.ts`
- Modify: `packages/appserver/src/types.ts`
- Modify: `packages/appserver/test/live.test.ts`
- Modify: `packages/coding-agent/src/session/appserver-authority.ts`
- Modify: `packages/coding-agent/src/cli/appserver-cli.ts`

- [ ] **Step 1: Write failing local admin tests**

Add UDS tests for `POST /admin/workspaces/register`, `GET /admin/workspaces/:id`, and `POST /admin/workspaces/:id/deregister`. Assert exact JSON keys, 64 KiB request cap, malformed/path-invalid rejection, idempotent replay, safe responses, and 404 on remote HTTP listeners. Assert the endpoint works in ordinary local mode without enabling remote pairing admin callbacks.

- [ ] **Step 2: Run tests and verify failure**

Run from OMP repo: `bun test packages/appserver/test/live.test.ts --test-name-pattern "workspace admin"`

Expected: FAIL with 404/missing authority.

- [ ] **Step 3: Wire the registry as a distinct local authority**

Add `workspaceAuthority` to `AppserverOptions`, not `AppserverAdminCallbacks`. Route it only from `LocalAppserver.fetch()` on the owner-only Unix socket. Do not add workspace routes to `remote/listener.ts`. Construct it in `createAppserverRuntime()` and pass it through `defaultCreateAppserver()` for local and direct-peer-backed appserver use.

- [ ] **Step 4: Run focused tests**

Run from OMP repo: `bun test packages/appserver/test/workspace-registry.test.ts packages/appserver/test/live.test.ts --test-name-pattern "workspace|admin"`

Expected: PASS.

- [ ] **Step 5: Commit in the OMP repo**

```bash
git add packages/appserver/src/server.ts packages/appserver/src/types.ts packages/appserver/test/live.test.ts packages/coding-agent/src/session/appserver-authority.ts packages/coding-agent/src/cli/appserver-cli.ts
git commit -m "feat(appserver): register workspaces over local admin"
```

### Task 3: Bind an OMP session to a registered workspace

**Files (OMP repo):**
- Modify: `packages/app-wire/src/additive.ts`
- Modify: `packages/app-wire/src/command.ts`
- Modify: `packages/app-wire/test/command.test.ts`
- Modify: `packages/app-wire/test/additive.test.ts`
- Modify: `packages/appserver/src/server.ts`
- Modify: `packages/appserver/src/types.ts`
- Modify: `packages/appserver/src/discovery.ts`
- Modify: `packages/appserver/test/live.test.ts`
- Modify: `packages/appserver/test/discovery.test.ts`

- [ ] **Step 1: Write failing wire and lifecycle tests**

Add additive feature `workspace.multi-root`. Extend only `session.create` arguments with optional `workspaceId`; reject it when the feature/authority is absent, unknown, already consumed incompatibly, or its primary root does not match `projectId`. Verify successful create stores stable aliases/root metadata, marks the registration in use, and returns no path. Verify restart discovery restores the workspace association.

- [ ] **Step 2: Run tests and verify failure**

Run from OMP repo: `bun test packages/app-wire/test/command.test.ts packages/app-wire/test/additive.test.ts packages/appserver/test/live.test.ts packages/appserver/test/discovery.test.ts --test-name-pattern "workspace|session.create"`

Expected: FAIL because `workspaceId` and the feature are unknown.

- [ ] **Step 3: Extend the wire additively**

Allow `session.create` keys `projectId`, `title`, and optional bounded opaque `workspaceId`. Do not change legacy create behavior. Add a safe workspace summary to the session index containing aliases, repo IDs, primary alias, branches, and abbreviated base revisions only.

- [ ] **Step 4: Persist the association**

Append a versioned OMP-owned session metadata entry or sidecar keyed by session ID; use the existing session directory and durable private-file conventions. `SessionRecord` receives a safe `workspace` descriptor plus a desktop-private resolved scope available only inside appserver runtime. Discovery must ignore malformed metadata safely and never infer roots from aliases.

- [ ] **Step 5: Run tests and typechecks**

Run from OMP repo: `bun test packages/app-wire/test/command.test.ts packages/app-wire/test/additive.test.ts packages/appserver/test/live.test.ts packages/appserver/test/discovery.test.ts --test-name-pattern "workspace|session.create" && bun --cwd=packages/app-wire run build && bun --cwd=packages/appserver run build`

Expected: PASS.

- [ ] **Step 6: Commit in the OMP repo**

```bash
git add packages/app-wire packages/appserver
git commit -m "feat(appserver): bind sessions to multi-root scope"
```

### Task 4A: Implement the immutable OMP workspace scope and context

**Files (OMP repo):**
- Create: `packages/coding-agent/src/session/workspace-scope.ts`
- Create: `packages/coding-agent/src/session/workspace-scope.test.ts`
- Modify: `packages/coding-agent/src/sdk.ts`
- Modify: `packages/coding-agent/src/system-prompt.ts`
- Modify: `packages/coding-agent/src/workspace-tree.ts`
- Modify: `packages/coding-agent/src/tools/path-utils.ts`

- [ ] **Step 1: Write failing scope/context tests**

Prove canonical symlink-aware containment; stable `repo://alias/path`; safe `../secondary-alias` resolution; traversal rejection; reads/searches from primary and secondary roots; and a deterministic `systemContext()` row for every root containing alias, stable relative path, repo ID, full base revision, and branch without an absolute path. Assert the primary row is marked and ordered first.

- [ ] **Step 2: Run tests and verify failure**

Run from OMP repo: `bun test packages/coding-agent/src/session/workspace-scope.test.ts --test-name-pattern "scope|context|secondary read"`

Expected: FAIL because `WorkspaceScope` is missing.

- [ ] **Step 3: Implement `WorkspaceScope` and SDK context**

Resolve aliases once, revalidate real paths before file use, and expose `contains`, `resolveAlias`, `logicalPath`, and `systemContext`. Add optional `workspaceScope` to `CreateAgentSessionOptions`, use it for workspace-tree roots and path resolution, and append its logical context to the system prompt. Reads remain allowed inside every root; known structured paths render as `repo://...`.

- [ ] **Step 4: Run tests/typecheck**

Run from OMP repo: `bun test packages/coding-agent/src/session/workspace-scope.test.ts --test-name-pattern "scope|context|secondary read" && bun --cwd=packages/coding-agent run check:types`

Expected: PASS.

- [ ] **Step 5: Commit in the OMP repo**

```bash
git add packages/coding-agent/src/session/workspace-scope.ts packages/coding-agent/src/session/workspace-scope.test.ts packages/coding-agent/src/sdk.ts packages/coding-agent/src/system-prompt.ts packages/coding-agent/src/workspace-tree.ts packages/coding-agent/src/tools/path-utils.ts
git commit -m "feat: model multi-root workspace scope"
```

### Task 4B: Hand workspace scope to RPC children and restore it

**Files (OMP repo):**
- Modify: `packages/appserver/src/rpc-child.ts`
- Modify: `packages/appserver/src/types.ts`
- Modify: `packages/appserver/test/appserver.test.ts`
- Modify: `packages/coding-agent/src/cli/flag-tables.ts`
- Modify: `packages/coding-agent/src/cli/args.ts`
- Modify: `packages/coding-agent/src/modes/rpc/rpc-mode.ts`

- [ ] **Step 1: Write failing RPC/resume tests**

Assert `RpcChildFactory` writes/passes a private scope file rather than JSON/env/log text; mode `0600`; bounded versioned decode; unlink after load and after child failure; RPC loads scope before `createAgentSession`; and a session resumed after appserver restart receives byte-for-byte identical aliases/roots.

- [ ] **Step 2: Run tests and verify failure**

Run from OMP repo: `bun test packages/appserver/test/appserver.test.ts --test-name-pattern "workspace scope|RPC resume"`

Expected: FAIL because RPC has no scope handoff.

- [ ] **Step 3: Implement private RPC handoff**

Extend `RpcChildFactory.spawn` to create/pass an owner-only short-lived file via `--workspace-scope-file`; validate size/version/permissions in RPC mode, unlink after loading, and source resumed scope only from appserver's persisted session association.

- [ ] **Step 4: Run tests/typechecks**

Run from OMP repo: `bun test packages/appserver/test/appserver.test.ts --test-name-pattern "workspace scope|RPC resume" && bun --cwd=packages/appserver run build && bun --cwd=packages/coding-agent run check:types`

Expected: PASS.

- [ ] **Step 5: Commit in the OMP repo**

```bash
git add packages/appserver/src/rpc-child.ts packages/appserver/src/types.ts packages/appserver/test/appserver.test.ts packages/coding-agent/src/cli/flag-tables.ts packages/coding-agent/src/cli/args.ts packages/coding-agent/src/modes/rpc/rpc-mode.ts
git commit -m "feat: restore workspace scope in RPC sessions"
```

### Task 4C: Enforce multi-root edit policy and primary Git/LSP context

**Files (OMP repo):**
- Create: `packages/coding-agent/src/tools/workspace-approval.ts`
- Create: `packages/coding-agent/src/tools/workspace-approval.test.ts`
- Modify: `packages/coding-agent/src/tools/write.ts`
- Modify: `packages/coding-agent/src/edit/index.ts`
- Modify: `packages/coding-agent/src/tools/bash.ts`
- Modify: `packages/coding-agent/src/tools/output-meta.ts`
- Modify: `packages/coding-agent/src/lsp/client.ts`

- [ ] **Step 1: Write failing approval/event/LSP tests**

Assert Auto edits applies to writes in primary and secondary roots; outside-root writes and commands prompt/deny; destructive, credential, publishing, and external-message commands still prompt; structured event paths use `repo://alias/path`; arbitrary free-form terminal/model text is not falsely claimed fully redacted; and Git/LSP startup remains at primary `cwd`.

- [ ] **Step 2: Run tests and verify failure**

Run from OMP repo: `bun test packages/coding-agent/src/tools/workspace-approval.test.ts --test-name-pattern "workspace|secondary|outside"`

Expected: FAIL because approvals know only the default mode/cwd.

- [ ] **Step 3: Implement shared approval logic**

Centralize path containment/tier selection in `workspace-approval.ts`; call it from write/edit/bash approval functions; apply logical aliases only to structured output metadata. Do not broaden browser/network/credential policies. Pass primary `cwd` unchanged to LSP.

- [ ] **Step 4: Run tests/package check**

Run from OMP repo: `bun test packages/coding-agent/src/tools/workspace-approval.test.ts packages/coding-agent/src/session/workspace-scope.test.ts && bun --cwd=packages/coding-agent run check:types`

Expected: PASS.

- [ ] **Step 5: Commit in the OMP repo**

```bash
git add packages/coding-agent/src/tools/workspace-approval.ts packages/coding-agent/src/tools/workspace-approval.test.ts packages/coding-agent/src/tools/write.ts packages/coding-agent/src/edit/index.ts packages/coding-agent/src/tools/bash.ts packages/coding-agent/src/tools/output-meta.ts packages/coding-agent/src/lsp/client.ts
git commit -m "feat: enforce multi-root edit approvals"
```

### Task 5: Expand T4 preparation to eager multi-repo worktrees

**Files:**
- Modify: `packages/protocol/src/desktop-ipc.ts`
- Modify: `packages/protocol/test/desktop-ipc.test.ts`
- Modify: `apps/desktop/src/session-workspace-manager.ts`
- Modify: `apps/desktop/test/session-workspace-manager.test.ts`
- Create: `apps/desktop/src/omp-workspace-admin.ts`
- Create: `apps/desktop/test/omp-workspace-admin.test.ts`
- Modify: `apps/desktop/src/workspace-manifest.ts`
- Modify: `apps/desktop/test/workspace-manifest.test.ts`
- Modify: `apps/desktop/src/workspace-recovery.ts`
- Modify: `apps/desktop/test/workspace-recovery.test.ts`

- [ ] **Step 1: Write failing multi-repo tests**

Accept `repositories[]` plus `primaryRepoId`. Test unique aliases, one branch name/suffix free across every repo, immutable base commits, all `planned` resources written before first mutation, sibling eager worktrees, rollback in reverse mutation order, OMP registration after every worktree exists, `session.create({ projectId, workspaceId })`, `session_unknown` reconciliation, and safe per-repo progress. Extend recovery to partial creation/cleanup of every repo plus OMP registration present/absent/in-use; recovery resumes or cleans each recorded resource idempotently and never treats a one-repo repair as whole-workspace success.

Implement this cancellation matrix:

| State | Required result |
|---|---|
| `planned` | enter `cleaning`, remove no uncreated resource, complete |
| `preparing_worktrees` | signal abort, await current atomic Git command, then reverse-clean only journal-owned resources |
| `registering_omp` before confirmed ID | await registration outcome; do not guess or clean while unknown |
| `registering_omp` with confirmed unused ID | deregister it, then reverse-clean owned Git resources |
| `session_pending` | cancel preparation and clean only after authoritative absence of a live session |
| `session_unknown` | return held/unknown; mutate nothing until reconciliation |
| `active` or later | reject cancel; require explicit finish/archive lifecycle |

- [ ] **Step 2: Run tests and verify failure**

Run: `pnpm --filter @t4-code/desktop test -- session-workspace-manager.test.ts workspace-recovery.test.ts omp-workspace-admin.test.ts workspace-manifest.test.ts && pnpm --filter @t4-code/protocol test -- desktop-ipc.test.ts`

Expected: FAIL because Increment 1 accepts one repo and has no OMP admin client.

- [ ] **Step 3: Implement `OmpWorkspaceAdmin`**

Call only the validated owner-only Unix socket using bounded JSON and timeouts. Absolute paths cross only this main-process-to-local-OMP boundary. Project responses into opaque IDs and stable error codes.

- [ ] **Step 4: Upgrade the transaction**

Resolve every base before mutation, find one collision-free branch, persist the full plan, create all worktrees, register OMP, create/reconcile the OMP session, and then expose `active`. Upgrade `WorkspaceRecovery` to iterate the complete repo resource ledger and OMP registration, with the tested state/outcome matrix. Retain single-repo compatibility without requiring OMP multi-root registration.

- [ ] **Step 5: Run tests**

Run: `pnpm --filter @t4-code/desktop test -- session-workspace-manager.test.ts workspace-recovery.test.ts omp-workspace-admin.test.ts workspace-manifest.test.ts && pnpm --filter @t4-code/protocol test -- desktop-ipc.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/protocol apps/desktop/src/session-workspace-manager.ts apps/desktop/test/session-workspace-manager.test.ts apps/desktop/src/workspace-recovery.ts apps/desktop/test/workspace-recovery.test.ts apps/desktop/src/omp-workspace-admin.ts apps/desktop/test/omp-workspace-admin.test.ts apps/desktop/src/workspace-manifest.ts apps/desktop/test/workspace-manifest.test.ts
git commit -m "feat: prepare multi-repository task workspaces"
```

### Task 6: Add typed repository/workspace jobs to the direct peer protocol

**Files:**
- Modify: `packages/protocol/src/peer-wire.ts`
- Modify: `packages/protocol/test/peer-wire.test.ts`
- Create: `apps/desktop/src/multi-repo-status.ts`
- Create: `apps/desktop/test/multi-repo-status.test.ts`
- Modify: `apps/desktop/src/peer-share.ts`
- Modify: `apps/desktop/test/peer-share.test.ts`
- Modify: `apps/desktop/src/lifecycle.ts`
- Modify: `apps/desktop/test/lifecycle-runtime.test.ts`
- Modify: `apps/web/src/platform/peer-transport.ts`
- Modify: `apps/web/test/peer-transport.test.ts`
- Modify: `apps/web/src/platform/browser-shell-port.ts`
- Modify: `apps/web/test/browser-platform.test.ts`

- [ ] **Step 1: Write failing strict-schema tests**

Add `repo.list`, `repo.branches.list`, `workspace.prepare`, `workspace.status`, `workspace.cancel`, and `workspace.review` operations with idempotency keys and bounded progress events. `workspace.review` is read-only and returns per-repo alias/label/branch/base, dirty state, ahead/behind, and bounded changed-file/diff summaries; Increment 3 extends it with finish actions. Reject paths, unknown fields, unauthorized repo IDs, shell fragments, oversized arrays/text, invalid cancellation state, and mutation replay with changed payload. Test disconnect/reconnect status recovery and a 256-event ring.

- [ ] **Step 2: Run tests and verify failure**

Run: `pnpm --filter @t4-code/protocol test -- peer-wire.test.ts && pnpm --filter @t4-code/desktop test -- multi-repo-status.test.ts peer-share.test.ts lifecycle-runtime.test.ts && pnpm --filter @t4-code/web test -- peer-transport.test.ts browser-platform.test.ts`

Expected: FAIL because peer workspace frames only support roots/folder creation.

- [ ] **Step 3: Add protocol frames and desktop dispatch**

Keep repository operations as a distinct `repo`/`workspace-job` frame family rather than overloading OMP `message` frames. Implement safe review projection in `MultiRepoStatus`; construct it with the registry/manager in `DesktopLifecycle`; pass the full repository workspace authority into `PeerShareHost` instead of only `WorkspaceRootsService`; dispatch only after HyperDHT authorization. Map errors to safe codes/messages and never forward raw subprocess output.

- [ ] **Step 4: Add mobile transport methods**

Use one pending-request map with timeout/close rejection. Long mutations return a job/workspace ID immediately; `workspace.status` supplies bounded progress after reconnect. Expose matching optional methods on `DesktopShellPort` through `browser-shell-port.ts`.

- [ ] **Step 5: Run tests**

Run: `pnpm --filter @t4-code/protocol test -- peer-wire.test.ts && pnpm --filter @t4-code/desktop test -- multi-repo-status.test.ts peer-share.test.ts lifecycle-runtime.test.ts && pnpm --filter @t4-code/web test -- peer-transport.test.ts browser-platform.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/protocol/src/peer-wire.ts packages/protocol/test/peer-wire.test.ts apps/desktop/src/multi-repo-status.ts apps/desktop/test/multi-repo-status.test.ts apps/desktop/src/peer-share.ts apps/desktop/test/peer-share.test.ts apps/desktop/src/lifecycle.ts apps/desktop/test/lifecycle-runtime.test.ts apps/web/src/platform/peer-transport.ts apps/web/test/peer-transport.test.ts apps/web/src/platform/browser-shell-port.ts apps/web/test/browser-platform.test.ts
git commit -m "feat: control repository jobs over direct peer"
```

### Task 7A: Upgrade the desktop launcher for multiple repositories

**Files:**
- Modify: `apps/web/src/features/new-task/new-task-store.ts`
- Modify: `apps/web/src/features/new-task/RepositoryPicker.tsx`
- Modify: `apps/web/src/features/new-task/NewTaskLauncher.tsx`
- Modify: `apps/web/test/new-task-store.test.ts`
- Modify: `apps/web/test/new-task-launcher.test.tsx`

- [ ] **Step 1: Write failing desktop launcher tests**

Cover multiple repo pills, exactly one Primary, stable repo ordering, per-repo base/immutable commit, one shared branch, bounded **Refresh remote branches** for each selected repo, cached-collision labels when refresh is off, model/mode, preparation stages, prompt preservation, and safe per-repo errors.

- [ ] **Step 2: Run tests and verify failure**

Run: `pnpm --filter @t4-code/web test -- new-task-store.test.ts new-task-launcher.test.tsx`

Expected: FAIL because the launcher accepts one repository.

- [ ] **Step 3: Implement multi-repo desktop submission**

Submit `repositories[]` and `primaryRepoId`; refresh selected repos with bounded parallelism of two; display cached/refreshed state per repo; preserve one branch preview and dirty-base confirmation per repo.

- [ ] **Step 4: Run tests/typecheck and commit**

Run: `pnpm --filter @t4-code/web test -- new-task-store.test.ts new-task-launcher.test.tsx && pnpm --filter @t4-code/web typecheck`

Expected: PASS.

```bash
git add apps/web/src/features/new-task/new-task-store.ts apps/web/src/features/new-task/RepositoryPicker.tsx apps/web/src/features/new-task/NewTaskLauncher.tsx apps/web/test/new-task-store.test.ts apps/web/test/new-task-launcher.test.tsx
git commit -m "feat: select multiple task repositories"
```

### Task 7B: Implement mobile task state, exact-once first prompt, and cache lifecycle

**Files:**
- Create: `apps/web/src/features/mobile-tasks/mobile-task-cache.ts`
- Create: `apps/web/src/features/mobile-tasks/mobile-task-store.ts`
- Create: `apps/web/test/mobile-task-cache.test.ts`
- Create: `apps/web/test/mobile-task-store.test.ts`
- Modify: `apps/web/src/state/workspace-store.ts`

- [ ] **Step 1: Write failing state/cache tests**

Cover multiple selected repos, one Primary, per-repo base/refresh status, preparation polling, the first prompt sent exactly once only after status becomes `active`, disconnect before/after that send, status-based reconnect without replaying `workspace.prepare` or the first prompt, later steering, offline-disabled mutations, cache scoping by desktop public identity, 30-day expiry, and immediate deletion of that identity's cache on pairing revoke. Cache must contain no path/transcript/credential.

- [ ] **Step 2: Run tests and verify failure**

Run: `pnpm --filter @t4-code/web test -- mobile-task-cache.test.ts mobile-task-store.test.ts`

Expected: FAIL because mobile task state/cache do not exist.

- [ ] **Step 3: Implement the state machine and cache**

Persist safe summaries plus an `initialPromptState: pending | sending | acknowledged`; only an acknowledged OMP prompt result advances it. After reconnect, query `workspace.status` and session transcript/revision before deciding whether an unknown send was accepted; never blindly duplicate. Subscribe to pairing revocation and purge the matching desktop cache.

- [ ] **Step 4: Run tests/typecheck and commit**

Run: `pnpm --filter @t4-code/web test -- mobile-task-cache.test.ts mobile-task-store.test.ts && pnpm --filter @t4-code/web typecheck`

Expected: PASS.

```bash
git add apps/web/src/features/mobile-tasks/mobile-task-cache.ts apps/web/src/features/mobile-tasks/mobile-task-store.ts apps/web/test/mobile-task-cache.test.ts apps/web/test/mobile-task-store.test.ts apps/web/src/state/workspace-store.ts
git commit -m "feat: persist mobile task state safely"
```

### Task 7C: Build the mobile launcher, feed, and multi-repo review surface

**Files:**
- Create: `apps/web/src/features/mobile-tasks/MobileTaskLauncher.tsx`
- Create: `apps/web/src/features/mobile-tasks/MobileTaskFeed.tsx`
- Create: `apps/web/src/features/mobile-tasks/MultiRepoReview.tsx`
- Create: `apps/web/test/mobile-task-flow.test.tsx`
- Create: `apps/web/test/multi-repo-review.test.tsx`
- Modify: `apps/web/src/components/HomePane.tsx`
- Modify: `apps/web/src/components/Titlebar.tsx`

- [ ] **Step 1: Write failing UI tests**

Cover multi-repo selection/refresh labels, live phases, approvals/questions, recent reopen, exact first-prompt transition, disconnect/reconnect, steer, and disabled offline mutations. `MultiRepoReview` must render one repo tab with Primary marker, branch/base, dirty/ahead/behind, bounded diff/changed files, and safe per-repo errors from `workspace.review`. Test 44px mobile controls.

- [ ] **Step 2: Run tests and verify failure**

Run: `pnpm --filter @t4-code/web test -- mobile-task-flow.test.tsx multi-repo-review.test.tsx`

Expected: FAIL because the mobile screens are missing.

- [ ] **Step 3: Implement responsive mobile UI**

Render the feed as connected mobile home; open the launcher/review from minimum 44px controls; keep pairing health secondary; omit desktop directory browsing; and use the existing OMP session runtime for transcript, steering, approvals, model/thinking, and terminal while `MultiRepoReview` consumes the T4 `workspace.review` projection.

- [ ] **Step 4: Run tests/typecheck and commit**

Run: `pnpm --filter @t4-code/web test -- mobile-task-flow.test.tsx multi-repo-review.test.tsx native-mobile.test.tsx mobile-touch-targets.test.tsx && pnpm --filter @t4-code/web typecheck`

Expected: PASS.

```bash
git add apps/web/src/features/mobile-tasks/MobileTaskLauncher.tsx apps/web/src/features/mobile-tasks/MobileTaskFeed.tsx apps/web/src/features/mobile-tasks/MultiRepoReview.tsx apps/web/test/mobile-task-flow.test.tsx apps/web/test/multi-repo-review.test.tsx apps/web/src/components/HomePane.tsx apps/web/src/components/Titlebar.tsx
git commit -m "feat: add mobile task feed and review"
```

### Task 8: Verify multi-root and mobile direct-peer behavior

**Files:**
- Modify only explicit fixes discovered during verification.

- [ ] **Step 1: Run OMP focused and full package checks**

Run from OMP repo: `bun test packages/app-wire/test packages/appserver/test packages/coding-agent/src/session/workspace-scope.test.ts && bun --cwd=packages/app-wire run build && bun --cwd=packages/appserver run build && bun --cwd=packages/coding-agent run check:types`

Expected: PASS.

- [ ] **Step 2: Run T4 checks**

Run: `pnpm --filter @t4-code/protocol test && pnpm --filter @t4-code/client test && pnpm --filter @t4-code/desktop test && pnpm --filter @t4-code/web test && pnpm check`

Expected: PASS.

- [ ] **Step 3: Run an Android emulator flow**

Build/install and launch the debug app:

Run: `pnpm --filter @t4-code/mobile build:android:debug && adb install -r apps/mobile/android/app/build/outputs/apk/debug/app-debug.apk && adb shell am force-stop com.lycaonsolutions.t4code && adb shell monkey -p com.lycaonsolutions.t4code 1`

At a human-verification checkpoint, record the workspace ID, session ID, branch, aliases, and screenshots while: pairing directly to desktop; selecting two approved repos; starting preparation; toggling emulator networking off/on during worktree creation; confirming the same job resumes without duplicate refs/worktrees; sending and steering a prompt; editing a file in each registered worktree; confirming an outside-root write prompts/fails; force-stopping/relaunching the app; reopening the same session; and opening the multi-repo review. Capture desktop `git worktree list --porcelain` and manifest safe status before/after. Expected: one branch/worktree per repo, identical IDs after reconnect/relaunch, edits in both roots, no outside write, and no relay/server fallback.

- [ ] **Step 4: Verify one real-phone direct flow**

Install the same APK on the user's phone, pair over direct HyperDHT, create/steer/reopen/review a two-repo session, close/reopen the mobile app, and confirm the same workspace/session IDs return. Record the safe IDs and desktop worktree/ref evidence; do not record keys, paths, or credentials. Expected: the real-phone flow succeeds without a hosted server or blind relay.

- [ ] **Step 5: Commit verification-only fixes in each affected repo**

In the T4 repo and OMP repo separately, run `git status --short`; stage only explicit files changed to fix verification failures and commit in that repository with `git commit -m "test: verify multi-repo mobile sessions"`. If a repo has no fix, do not create an empty commit.
