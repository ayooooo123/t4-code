# Repository Launcher and Single-Repo Isolation Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let desktop users register approved Git repositories and start each new task in a crash-recoverable, isolated branch/worktree before the first OMP prompt.

**Architecture:** T4 desktop owns canonical paths, Git subprocesses, branch naming, manifests, and worktrees. The renderer receives opaque repository/workspace IDs and safe metadata through strict IPC, while OMP continues to own the session and prompt through its existing single-project mechanism. A desktop-private journal is durably updated before and after every mutation so startup can reconcile or clean only T4-owned resources.

**Tech Stack:** TypeScript, Electron IPC/preload, React/Zustand, Node `child_process`/`fs`, Git worktrees, OMP appserver protocol, Vite Plus tests

---

**Spec:** `docs/superpowers/specs/2026-07-16-repository-worktree-mobile-sessions-design.md`

**Repository:** Run all paths and commands in the T4 worktree unless explicitly marked otherwise.

## Chunk 1: Desktop Repository Authority, Worktree Transaction, and Launcher

### Task 1: Define strict repository/workspace desktop contracts

**Files:**
- Modify: `packages/protocol/src/desktop-ipc.ts`
- Modify: `packages/protocol/test/desktop-ipc.test.ts`
- Modify: `packages/protocol/test/reexport.test.ts`

- [ ] **Step 1: Write failing decoder tests**

Add table-driven tests for these channels and exact payloads:

```ts
"omp:repos:list"                 // {}
"omp:repos:add:choose"           // {}
"omp:repos:branches:list"        // { repoId, refreshRemote }
"omp:workspaces:prepare"         // { operationId, repoId, baseRef, branch, prompt, model?, mode, continueWithDirtyBase }
"omp:workspaces:status"          // { workspaceId }
"omp:workspaces:cancel"          // { workspaceId }
```

Assert unknown keys, absolute paths, control characters, leading-option refs, oversized values, invalid modes, non-boolean dirty acknowledgement, and malformed operation IDs are rejected. Assert prepare returns `{ workspaceId, state, stage, progress }` immediately after the durable `planned` record exists; callers use that ID for status/cancel while work continues. Assert every response exposes only opaque IDs, display labels, branch/ref metadata, short commit IDs, dirty state, state/stage, bounded errors, and session/project IDs—never local paths.

- [ ] **Step 2: Run protocol tests and verify failure**

Run: `pnpm --filter @t4-code/protocol test -- desktop-ipc.test.ts reexport.test.ts`

Expected: FAIL because the channels and types do not exist.

- [ ] **Step 3: Add the contracts and exact decoders**

Define and export:

```ts
export type WorkspacePermissionMode = "auto_edits" | "confirm_edits";
export type WorkspacePreparationState =
  | "planned" | "preparing_worktrees" | "session_pending"
  | "session_unknown" | "active" | "cleaning" | "complete" | "failed";

export interface RepositorySummary {
  readonly id: string;
  readonly label: string;
  readonly remoteSlug?: string;
  readonly currentBranch: string | null;
  readonly defaultBranch: string | null;
  readonly dirty: boolean;
  readonly available: boolean;
  readonly createdByT4: boolean;
}
export interface RepositoryListResult { readonly repositories: readonly RepositorySummary[]; }
export interface RepositoryChooseResult { readonly repository: RepositorySummary | null; }
export interface RepositoryBranch { readonly name: string; readonly commit: string; readonly current: boolean; readonly remoteTracking: boolean; }
export interface RepositoryBranchesResult { readonly repoId: string; readonly branches: readonly RepositoryBranch[]; readonly remoteState: "cached" | "refreshed"; }

export type WorkspaceStage = "validating" | "resolving_base" | "creating_branch" | "creating_worktree" | "starting_session" | "reconciling" | "cleaning" | "complete";
export type WorkspaceErrorCode = "repo_unavailable" | "dirty_base" | "base_ref_missing" | "branch_collision" | "worktree_failed" | "omp_unavailable" | "session_outcome_unknown" | "cleanup_incomplete";
export interface WorkspaceProgress { readonly sequence: number; readonly stage: WorkspaceStage; readonly message: string; readonly at: string; }
export interface WorkspaceError { readonly code: WorkspaceErrorCode; readonly message: string; readonly repoId?: string; readonly stage: WorkspaceStage; }
export interface WorkspaceStatusResult {
  readonly workspaceId: string;
  readonly state: WorkspacePreparationState;
  readonly stage: WorkspaceStage;
  readonly progress: readonly WorkspaceProgress[];
  readonly projectId?: string;
  readonly sessionId?: string;
  readonly error?: WorkspaceError;
}
export type WorkspacePrepareResult = WorkspaceStatusResult;
export interface WorkspaceCancelResult { readonly workspaceId: string; readonly state: "session_unknown" | "cleaning" | "complete"; readonly held: boolean; }
```

Use explicit `exact(...)` allowlists. `repos:list` returns `RepositoryListResult`, the picker returns `RepositoryChooseResult`, and branch listing returns `RepositoryBranchesResult`; commits are full lowercase hex in the protocol and abbreviated only for display. Bound IDs/ref names to 256 UTF-8 bytes, prompt to 64 KiB, labels to 128 bytes, progress/error messages to 512 bytes, and progress history to 256 entries. Require operation IDs to match `/^[A-Za-z0-9_-]{16,128}$/` and reject `baseRef`/`branch` beginning with `-`. Require `continueWithDirtyBase` explicitly (default the UI to `false`). Do not accept any path field.

- [ ] **Step 4: Run protocol tests and typecheck**

Run: `pnpm --filter @t4-code/protocol test -- desktop-ipc.test.ts reexport.test.ts && pnpm --filter @t4-code/protocol typecheck`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/protocol/src/desktop-ipc.ts packages/protocol/test/desktop-ipc.test.ts packages/protocol/test/reexport.test.ts
git commit -m "feat: define repository workspace IPC"
```

### Task 2: Add an argv-only bounded Git adapter

**Files:**
- Create: `apps/desktop/src/git-runner.ts`
- Create: `apps/desktop/src/repository-git.ts`
- Create: `apps/desktop/test/git-runner.test.ts`
- Create: `apps/desktop/test/repository-git.test.ts`

- [ ] **Step 1: Write failing subprocess and temporary-repository tests**

Test that `GitRunner` uses `spawn(file, args, { shell: false })`, caps stdout/stderr, defaults to a 30-second timeout, rejects timeouts above 5 minutes, terminates on timeout/abort/output overflow, redacts credential-like text, and reports exact codes `git_timeout`, `git_cancelled`, `git_output_limit`, or `git_failed`. In temporary repos, test canonical top-level discovery, bare-repo rejection, detached HEAD, dirty status, current/default branch discovery, local plus remote-tracking collision detection, immutable ref resolution, and `git check-ref-format --branch` validation.

- [ ] **Step 2: Run the tests and verify failure**

Run: `pnpm --filter @t4-code/desktop test -- git-runner.test.ts repository-git.test.ts`

Expected: FAIL because both modules are missing.

- [ ] **Step 3: Implement `GitRunner`**

Expose only:

```ts
export interface GitRunRequest {
  readonly cwd: string;
  readonly args: readonly string[];
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
  readonly maxOutputBytes?: number;
}
export interface GitRunResult { readonly stdout: string; readonly stderr: string; }
export type GitRunErrorCode = "git_timeout" | "git_cancelled" | "git_output_limit" | "git_failed";
export class GitRunner { run(request: GitRunRequest): Promise<GitRunResult>; }
```

Always invoke `git` with an argument vector and `shell: false`; never accept a command string. Default timeout to 30 seconds, cap it at 5 minutes, default output to 1 MiB, kill on overflow, and retain only a 2 KiB redacted diagnostic suffix. Use `--` before user-controlled refs where Git supports it and reject NUL/control characters and leading-option refs before invocation.

- [ ] **Step 4: Implement repository-specific Git queries**

`RepositoryGit` should provide `inspect`, `listBranches`, `resolveCommit`, `branchExists`, `createBranchAtCommit`, `createWorktreeForBranch`, `removeWorktree`, `deleteOwnedBranch`, and `pruneWorktrees`. Branch creation and worktree creation are separate observable mutations so the journal can durably record the created branch before the worktree command starts. Treat nested repositories as independent top levels, preserve sparse checkout, never initialize submodules, and return stable error codes instead of raw stderr.

- [ ] **Step 5: Run focused tests**

Run: `pnpm --filter @t4-code/desktop test -- git-runner.test.ts repository-git.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/git-runner.ts apps/desktop/src/repository-git.ts apps/desktop/test/git-runner.test.ts apps/desktop/test/repository-git.test.ts
git commit -m "feat: add hardened desktop git adapter"
```

### Task 3: Build the approved repository registry

**Files:**
- Create: `apps/desktop/src/repository-registry.ts`
- Create: `apps/desktop/test/repository-registry.test.ts`
- Modify: `apps/desktop/src/workspace-roots.ts`
- Modify: `apps/desktop/test/workspace-roots.test.ts`
- Modify: `apps/desktop/src/stores.ts`
- Modify: `apps/desktop/test/stores-lifecycle.test.ts`

- [ ] **Step 1: Write failing registry tests**

Cover: canonicalization; containment in an approved root; symlink escape rejection; stable opaque IDs across reload; duplicate canonical-path deduplication; path-free public summaries; unavailable repo retention; dirty/current/default branch refresh; and rejection of files, non-Git directories, bare repos, and unapproved paths.

- [ ] **Step 2: Run tests and verify failure**

Run: `pnpm --filter @t4-code/desktop test -- repository-registry.test.ts workspace-roots.test.ts stores-lifecycle.test.ts`

Expected: FAIL because repository registration and private path lookup are missing.

- [ ] **Step 3: Expose a desktop-private approved-root lookup**

Add `WorkspaceRootsService.resolveApprovedPath(rootId)` and `findContainingRoot(canonicalPath)`. These return paths only inside desktop main-process code; do not add them to IPC or peer contracts.

- [ ] **Step 4: Implement `RepositoryRegistry`**

Persist a versioned private record with `{ id, canonicalPath, rootId, createdByT4, remoteSlug? }`. Generate IDs with `randomUUID`; never derive them from paths. Reinspect Git state on `list()` and project only `RepositorySummary` fields. Add `ElectronRepositoryStore` following `ElectronWorkspaceRootsStore` in `stores.ts`.

- [ ] **Step 5: Run tests**

Run: `pnpm --filter @t4-code/desktop test -- repository-registry.test.ts workspace-roots.test.ts stores-lifecycle.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/repository-registry.ts apps/desktop/test/repository-registry.test.ts apps/desktop/src/workspace-roots.ts apps/desktop/test/workspace-roots.test.ts apps/desktop/src/stores.ts apps/desktop/test/stores-lifecycle.test.ts
git commit -m "feat: register approved local repositories"
```

### Task 4: Add branch derivation and a durable workspace manifest journal

**Files:**
- Create: `apps/desktop/src/workspace-branch.ts`
- Create: `apps/desktop/test/workspace-branch.test.ts`
- Create: `apps/desktop/src/workspace-manifest.ts`
- Create: `apps/desktop/test/workspace-manifest.test.ts`

- [ ] **Step 1: Write failing branch tests**

Test examples such as `"Fix HyperDHT reconnect!" -> "t4/fix-hyperdht-reconnect"`, Unicode/transliteration fallback, empty prompt fallback, reserved/ref-invalid components, explicit edited names, 80-character bounds, and numeric suffix selection against local and cached remote branches.

- [ ] **Step 2: Write failing journal tests**

Use an injected filesystem recorder to verify: planned manifest precedes mutation callbacks; completed branch creation is journaled before worktree creation; completed worktree creation is journaled before OMP session creation; completed session-file creation is journaled before appserver reconciliation; each write uses same-directory temp file, file fsync, rename, and directory fsync; ownership nonce persists; invalid/unknown versions are quarantined; event history is capped at 256; diagnostics are redacted/capped; state transitions reject illegal backward moves; completed summaries at exactly 30 days are pruned only when every owned resource is `removed`; and 29-day summaries or summaries retaining any resource are preserved.

- [ ] **Step 3: Run tests and verify failure**

Run: `pnpm --filter @t4-code/desktop test -- workspace-branch.test.ts workspace-manifest.test.ts`

Expected: FAIL because both modules are missing.

- [ ] **Step 4: Implement branch naming**

Export `deriveBranch(prompt)`, `validateBranch(value)`, and `chooseAvailableBranch(preview, existingRefs)`. Prefix generated names with `t4/`, preserve a valid explicit `t4/...` edit, and choose one suffix only after checking every supplied ref set.

- [ ] **Step 5: Implement the journal**

Use a private version-1 manifest containing workspace/job IDs, nonce, repo ID, base ref/commit, branch, worktree path, project/session IDs, owned resources with per-resource `planned | created | removed` state, preparation state, progress ring, and timestamps. Absolute paths remain only in this private file. Add `scanIncomplete()`, `createPlanned()`, `recordResourceCreated()`, `recordResourceRemoved()`, `transition()`, `complete()`, and `pruneCompleted(now)`. Every mutation method must await its durable journal update before the manager begins the next mutation. Completed summaries are eligible for deletion after 30 days only when no owned resource remains.

- [ ] **Step 6: Run tests**

Run: `pnpm --filter @t4-code/desktop test -- workspace-branch.test.ts workspace-manifest.test.ts`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/desktop/src/workspace-branch.ts apps/desktop/test/workspace-branch.test.ts apps/desktop/src/workspace-manifest.ts apps/desktop/test/workspace-manifest.test.ts
git commit -m "feat: journal isolated task workspaces"
```

### Task 5: Prepare, reconcile, and clean single-repo workspaces

**Files:**
- Create: `apps/desktop/src/omp-session-files.ts`
- Create: `apps/desktop/test/omp-session-files.test.ts`
- Create: `apps/desktop/src/session-workspace-manager.ts`
- Create: `apps/desktop/test/session-workspace-manager.test.ts`
- Create: `apps/desktop/src/workspace-recovery.ts`
- Create: `apps/desktop/test/workspace-recovery.test.ts`
- Modify: `apps/desktop/src/workspace-roots.ts`
- Modify: `apps/desktop/test/workspace-roots.test.ts`

- [ ] **Step 1: Write failing OMP session-file tests**

Test deterministic IDs/timestamps, canonical macOS-style paths, `0600` file creation, `0700` directories, no overwrite, and the exact returned `{ sessionId, sessionFile }` while requiring `WorkspaceRootsService.createProject()` behavior to remain unchanged.

- [ ] **Step 2: Run the session-file tests and verify failure**

Run: `pnpm --filter @t4-code/desktop test -- omp-session-files.test.ts workspace-roots.test.ts`

Expected: FAIL because `omp-session-files.ts` does not exist.

- [ ] **Step 3: Extract the existing OMP empty-session writer**

Move `uuidV7`, the fixed-size title slot, session-directory resolution, and file creation from `workspace-roots.ts` into `omp-session-files.ts`; expose `createEmptyOmpSession(cwd, options): Promise<{ sessionId: string; sessionFile: string }>` and update `WorkspaceRootsService` to call it while discarding the private return value.

- [ ] **Step 4: Run the session-file tests**

Run: `pnpm --filter @t4-code/desktop test -- omp-session-files.test.ts workspace-roots.test.ts`

Expected: PASS.

- [ ] **Step 5: Write failing workspace transaction and recovery tests**

With temporary repos and fake journal/session discovery, prove:

- dirty base changes are excluded and require `continueWithDirtyBase: true`;
- base ref resolves to an immutable commit before journal creation;
- branch/worktree live at `<workspaceRoot>/<workspaceId>/repos/<alias>`;
- the branch uses the chosen collision-free name;
- an OMP session file is created with the worktree as `cwd` and becomes discoverable;
- prompt/model/mode remain only in the renderer draft and are never copied into Git metadata or the private Git resource journal;
- failure removes only nonce-owned worktree/branch;
- `session_unknown` never rolls back until discovery reconciliation;
- cancellation is legal only before `active`;
- startup reconciliation repairs stale `preparing_worktrees`/`session_pending` jobs without touching base checkouts.

In `workspace-recovery.test.ts`, implement this exact table:

| Manifest/resources | Observed state | Expected recovery |
|---|---|---|
| `planned`, none created | any | transition `failed` with `preparation_interrupted`; no Git mutation |
| `preparing_worktrees`, branch only | branch matches plan | resume worktree creation |
| `preparing_worktrees`, branch+worktree | both match plan | resume session creation |
| `session_pending`, no session file | worktree valid | create session file once |
| `session_pending`, session file exists | OMP session present | promote `active` |
| `session_pending`, session file exists | OMP session absent | request discovery refresh, remain pending |
| `session_unknown` | OMP session present | promote `active` |
| `session_unknown` | OMP session absent after authoritative list | enter `cleaning` and roll back owned resources |
| `session_unknown` | OMP unreachable/non-authoritative | remain `session_unknown`, mutate nothing, hold cancel |
| `cleaning` | owned resource present | remove it, durably record `removed`, then continue |
| `cleaning` | owned resource absent | durably record `removed`, then continue idempotently |

Test operation-ID replay: the same ID and identical payload returns the existing workspace/status, while the same ID with a changed payload is rejected without mutation.

- [ ] **Step 6: Run transaction/recovery tests and verify failure**

Run: `pnpm --filter @t4-code/desktop test -- session-workspace-manager.test.ts workspace-recovery.test.ts`

Expected: FAIL because the manager and recovery reconciler do not exist.

- [ ] **Step 7: Implement `SessionWorkspaceManager` and `WorkspaceRecovery`**

Keep new-task orchestration/cancellation in `SessionWorkspaceManager`; put startup inspection and the state/outcome matrix in `WorkspaceRecovery`. Serialize mutations per repository. Validate registry visibility, warn/refuse dirty bases unless explicitly continued, resolve the commit, choose the branch, call `journal.createPlanned()` before Git, and await `recordResourceCreated()` after branch, worktree, and OMP-session mutations before continuing. Poll the existing local target/session inventory for the exact session ID. Reconcile without guessing when OMP is unreachable. Return a path-free safe projection. Abort subprocesses on cancel, wait for the current Git action, then durably record cleanup of nonce-owned resources.

- [ ] **Step 8: Run focused tests**

Run: `pnpm --filter @t4-code/desktop test -- omp-session-files.test.ts session-workspace-manager.test.ts workspace-recovery.test.ts workspace-roots.test.ts`

Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add apps/desktop/src/omp-session-files.ts apps/desktop/test/omp-session-files.test.ts apps/desktop/src/session-workspace-manager.ts apps/desktop/test/session-workspace-manager.test.ts apps/desktop/src/workspace-recovery.ts apps/desktop/test/workspace-recovery.test.ts apps/desktop/src/workspace-roots.ts apps/desktop/test/workspace-roots.test.ts
git commit -m "feat: prepare isolated repository sessions"
```

### Task 6: Wire desktop IPC, preload, lifecycle, and recovery

**Files:**
- Modify: `apps/desktop/src/ipc.ts`
- Modify: `apps/desktop/test/ipc-lifecycle.test.ts`
- Modify: `apps/desktop/src/preload.ts`
- Modify: `packages/client/src/desktop-runtime-contracts.ts`
- Modify: `packages/client/test/desktop-runtime.test.ts`
- Modify: `apps/desktop/src/lifecycle.ts`
- Modify: `apps/desktop/test/lifecycle-runtime.test.ts`
- Modify: `apps/desktop/test/desktop-lifecycle.test.ts`

- [ ] **Step 1: Write failing boundary/lifecycle tests**

Assert trusted-sender enforcement, request serialization, path-free results/errors, native folder picker registration, preload method names, handler uninstall, startup recovery before launcher readiness, graceful shutdown/cancellation, and every row of the Task 5 recovery matrix through lifecycle startup. Extend fake `DesktopShellPort` implementations only with optional methods.

- [ ] **Step 2: Run tests and verify failure**

Run: `pnpm --filter @t4-code/desktop test -- ipc-lifecycle.test.ts lifecycle-runtime.test.ts desktop-lifecycle.test.ts && pnpm --filter @t4-code/client test -- desktop-runtime.test.ts`

Expected: FAIL because the handlers and shell methods are missing.

- [ ] **Step 3: Wire services through the main process**

Construct `RepositoryRegistry`, `WorkspaceManifestStore`, `WorkspaceRecovery`, and `SessionWorkspaceManager` once in `DesktopLifecycle`; run `WorkspaceRecovery.reconcileIncomplete()` and `pruneCompleted(Date.now())` after app readiness but before launcher readiness; pass the manager/registry into `DesktopIpcRegistry`; and use `dialog.showOpenDialog({ properties: ["openDirectory"] })` only for desktop repo registration. Add all new channels to `uninstall()`.

- [ ] **Step 4: Wire preload and client contracts**

Add optional `repoList`, `repoAddChoose`, `repoBranchesList`, `workspacePrepare`, `workspaceStatus`, and `workspaceCancel` methods to `OmpShellBridge` and `DesktopShellPort`. All methods call typed IPC; none accept paths.

- [ ] **Step 5: Run tests and typechecks**

Run: `pnpm --filter @t4-code/desktop test -- ipc-lifecycle.test.ts lifecycle-runtime.test.ts desktop-lifecycle.test.ts && pnpm --filter @t4-code/client test -- desktop-runtime.test.ts && pnpm --filter @t4-code/desktop typecheck && pnpm --filter @t4-code/client typecheck`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/ipc.ts apps/desktop/test/ipc-lifecycle.test.ts apps/desktop/src/preload.ts packages/client/src/desktop-runtime-contracts.ts packages/client/test/desktop-runtime.test.ts apps/desktop/src/lifecycle.ts apps/desktop/test/lifecycle-runtime.test.ts apps/desktop/test/desktop-lifecycle.test.ts
git commit -m "feat: expose repository workspaces to desktop"
```

### Task 7: Build the desktop New Task launcher

**Files:**
- Create: `apps/web/src/features/new-task/new-task-store.ts`
- Create: `apps/web/src/features/new-task/RepositoryPicker.tsx`
- Create: `apps/web/src/features/new-task/PreparationProgress.tsx`
- Create: `apps/web/src/features/new-task/NewTaskLauncher.tsx`
- Create: `apps/web/test/new-task-store.test.ts`
- Create: `apps/web/test/new-task-launcher.test.tsx`
- Modify: `apps/web/src/components/HomePane.tsx`
- Modify: `apps/web/src/features/session-runtime/live-create.ts`
- Modify: `apps/web/test/live-create.test.ts`
- Modify: `apps/web/src/state/workspace-store.ts`
- Modify: `apps/web/test/workspace-store.test.ts`

- [ ] **Step 1: Write failing store and component tests**

Cover empty/ready/dirty/preparing/error/retry/cancel/success states; one Primary repo pill; branch preview regeneration until manually edited; base selector; **Refresh remote branches** control; a visible "remote branches cached" label when refresh is off; model selector; Auto edits default; prompt preservation on failure; and disabled submit while disconnected or recovering. Before allocating an operation ID/submitting, combine `RepositorySummary.dirty` with the selected `RepositoryBranch.commit`; require a warning that shows the exact abbreviated immutable commit plus separate Cancel and Continue from committed revision actions. Only Continue sets `continueWithDirtyBase: true` on the first immutable prepare payload. Verify no absolute path renders or persists.

- [ ] **Step 2: Run tests and verify failure**

Run: `pnpm --filter @t4-code/web test -- new-task-store.test.ts new-task-launcher.test.tsx live-create.test.ts workspace-store.test.ts`

Expected: FAIL because launcher modules are missing.

- [ ] **Step 3: Implement the launcher state machine**

Keep drafts and safe selections in renderer state, but query desktop before submit. Pass `refreshRemote` to branch listing and display whether collision information is live or cached. Resolve the dirty warning/choice before generating the operation ID; after submission the payload is immutable and identical-ID replay is permitted only with byte-identical fields. On submit call `workspacePrepare`, retain its immediate `workspaceId`, poll `workspaceStatus`, show host-reported stages, activate the returned session, then send the first prompt through the existing live runtime. Do not call `session.create` a second time: Increment 1 preparation returns the already created/discovered OMP session.

- [ ] **Step 4: Integrate with `HomePane`**

Replace the connected/empty desktop state with `NewTaskLauncher`; retain service, pairing, connecting, and error panes. Preserve historical/non-Git session navigation in the rail.

- [ ] **Step 5: Run tests and web typecheck**

Run: `pnpm --filter @t4-code/web test -- new-task-store.test.ts new-task-launcher.test.tsx live-create.test.ts workspace-store.test.ts && pnpm --filter @t4-code/web typecheck`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/features/new-task apps/web/test/new-task-store.test.ts apps/web/test/new-task-launcher.test.tsx apps/web/src/components/HomePane.tsx apps/web/src/features/session-runtime/live-create.ts apps/web/test/live-create.test.ts apps/web/src/state/workspace-store.ts apps/web/test/workspace-store.test.ts
git commit -m "feat: add desktop repository task launcher"
```

### Task 8: Verify Increment 1 end to end

**Files:**
- No planned file changes; stage only explicit verification fixes discovered below.

- [ ] **Step 1: Run focused suites**

Run: `pnpm --filter @t4-code/protocol test && pnpm --filter @t4-code/client test && pnpm --filter @t4-code/desktop test && pnpm --filter @t4-code/web test`

Expected: PASS.

- [ ] **Step 2: Run repository-wide checks**

Run: `pnpm check && pnpm build:web && pnpm build:desktop`

Expected: PASS with no lint/type/build errors.

- [ ] **Step 3: Perform a manual desktop smoke test**

In a disposable Git repo under an approved root, capture `git status --porcelain=v1`, `git show-ref --heads`, and `git worktree list --porcelain` before registration. Add one uncommitted marker, start a task after acknowledging the warning, and run the same commands in the base checkout plus `git -C <test worktree> status --porcelain=v1` and `git -C <test worktree> rev-parse HEAD`. Expected: the marker remains only in the base checkout; worktree HEAD equals the previewed base commit; exactly one `t4/...` branch/worktree exists; the returned OMP session ID reopens after quit/relaunch. Start/cancel a second job and repeat the ref/worktree commands; expected: its owned ref/worktree are absent and every pre-existing ref/worktree/status line is unchanged.

- [ ] **Step 4: Commit verification-only fixes**

List changed files with `git status --short`; stage only files directly changed to fix verification failures, then commit them with `git commit -m "test: verify isolated repository launcher"`. If no fix was required, do not create an empty commit.
