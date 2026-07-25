# GitHub Acquisition and Workspace Finish Lifecycle Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let desktop and mobile safely use/clone/fork GitHub repositories, review every repository in a task, and explicitly keep, commit, push, open PRs, merge locally, archive, or discard T4-owned work.

**Architecture:** Desktop-only acquisition and finish services execute bounded argv-only `git`/`gh` operations against the registry and workspace journal. Every external mutation is explicit, idempotent, and recorded per repository; partial success is preserved for targeted retry. Strict IPC/direct-peer projections drive shared desktop/mobile review UI without exposing paths or credentials, and local merge uses either a detached integration worktree plus compare-and-swap or an explicitly confirmed clean user checkout.

**Tech Stack:** TypeScript, Electron main process, Git and GitHub CLI argv APIs, strict desktop/HyperDHT protocols, React/Zustand, Capacitor Android, macOS Electron packaging, Vite Plus tests

---

**Spec:** `docs/superpowers/specs/2026-07-16-repository-worktree-mobile-sessions-design.md`

**Prerequisite:** Complete the Increment 1 and Increment 2 plans first.

**Repository:** Run all paths and commands in the T4 worktree.

## Chunk 1: GitHub Contracts and Acquisition

### Task 1: Define GitHub acquisition and finish contracts

**Files:**
- Modify: `packages/protocol/src/desktop-ipc.ts`
- Modify: `packages/protocol/test/desktop-ipc.test.ts`
- Modify: `packages/protocol/src/peer-wire.ts`
- Modify: `packages/protocol/test/peer-wire.test.ts`

- [ ] **Step 1: Write failing strict-schema tests**

Add operations:

```ts
"omp:repos:acquire:preview"   // { operationId, source: { owner, repo }, action, rootId? }
"omp:repos:acquire:execute"   // { operationId, previewId }
"omp:repos:fork-cleanup:preview" // { operationId, forkRecordId }
"omp:repos:fork-cleanup:execute" // { operationId, previewId, confirmationId }
"omp:jobs:status"             // { jobId, afterSequence? }
"omp:workspaces:review"       // { workspaceId } — desktop IPC view of Increment 2 authority
"omp:workspaces:finish"       // { operationId, workspaceId, actions[] }
```

Mirror the new mutation/status operations as peer operations `repo.acquire.preview`, `repo.acquire.execute`, `repo.fork_cleanup.preview`, `repo.fork_cleanup.execute`, `job.status`, and `workspace.finish`; Increment 2 already owns peer `workspace.review`, whose safe result is extended rather than replaced, while this increment exposes the same authority through desktop IPC. Test exact keys; GitHub owner `/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/` and repo `/^[A-Za-z0-9._-]{1,100}$/`; allowed acquisition actions `use_existing | clone | fork`; per-repo target/base/commit message/PR title/body bounds; explicit confirmations for fork deletion, user-checkout merge, and discard; idempotency keys; and rejection of URLs, paths, shell syntax, credentials, malformed IDs, or ambiguous action combinations. Protocol tests validate shape and bounds only; tests for whether opaque root/repository/workspace/preview IDs are currently authorized belong to the desktop service and peer-boundary tasks.

Define a discriminated `FinishStep` union: `{ type:"commit", message }`, `{ type:"push" }`, `{ type:"open_pr", targetBranch, title, body }`, or `{ type:"merge_local", targetBranch, checkoutConfirmationId? }`. `FinishRepositoryPlan` is `{ repoId, steps }`, capped at 16 plans with unique repo IDs and 3 steps per plan. Legal step sequences are exactly `[commit]`, `[push]`, `[commit,push]`, `[push,open_pr]`, `[commit,push,open_pr]`, or `[merge_local]`; `open_pr` requires `push` in the same pipeline and merge is exclusive. `FinishRequest` also has one workspace lifecycle `{ action:"keep" } | { action:"archive" } | { action:"discard", confirmationId }`. Publish/merge results remain per repo; after all requested repo steps settle, the lifecycle action fans out across every workspace repo. `archive` archives the single OMP session then removes only clean owned worktrees while preserving branches; `discard` closes/archives the session then removes every confirmed nonce-owned worktree/branch. Mixed per-repo keep/archive/discard is impossible by schema. Bound commit message to 4 KiB, PR title to 256 bytes, PR body to 64 KiB, branch to 256 bytes, and confirmation IDs to 256 bytes.

- [ ] **Step 2: Run tests and verify failure**

Run: `pnpm --filter @t4-code/protocol test -- desktop-ipc.test.ts peer-wire.test.ts`

Expected: FAIL because acquisition, generic job status, and finish operations are absent and review lacks the finish-era fields.

- [ ] **Step 3: Implement exact safe types and decoders**

Define the wire contracts exactly as follows (all IDs are opaque 1–128 byte strings, labels/messages are UTF-8 bounded, timestamps are non-negative safe integers, and every object rejects unknown keys):

```ts
type SafeErrorCode =
  | "github_auth_required" | "github_forbidden" | "github_network"
  | "github_conflict" | "github_outcome_unknown" | "github_failed"
  | "preview_expired" | "preview_changed" | "root_unavailable"
  | "destination_exists" | "remote_mismatch" | "operation_conflict"
  | "not_found" | "not_authorized" | "events_expired" | "internal_failed";

type AcquisitionPreview = {
  previewId: string; operationId: string; expiresAtMs: number;
  source: { owner: string; repo: string };
  action: "use_existing" | "clone" | "fork";
  account: { login: string } | null;
  destination: { rootId: string; rootLabel: string; folderLabel: string; existingRepoId: string | null };
  effects: readonly ("reuse_local" | "clone_source" | "create_or_reuse_fork" | "set_origin" | "set_upstream")[];
  warnings: readonly { code: string; message: string }[];
};
type AcquisitionResult = { repoId: string; source: { owner: string; repo: string }; action: AcquisitionPreview["action"]; fork: { forkRecordId: string; owner: string; repo: string } | null };
type AcquisitionStatus =
  | { state: "pending" | "running"; phase: "planned" | "fork_requested" | "fork_confirmed" | "clone_staged" | "clone_renamed" | "remotes_verified" | "registering" }
  | { state: "succeeded"; result: AcquisitionResult }
  | { state: "failed" | "outcome_unknown"; error: { code: SafeErrorCode; message: string; retryable: boolean } };
type ForkCleanupPreview = { previewId: string; operationId: string; expiresAtMs: number; forkRecordId: string; registeredRepoId: string | null; fork: { owner: string; repo: string }; source: { owner: string; repo: string }; t4Created: boolean; blockers: readonly ("not_t4_owned" | "open_pr" | "unmerged_branch" | "branch_limit" | "comparison_unknown" | "identity_changed")[] };
type ForkCleanupStatus =
  | { state: "pending" | "running" }
  | { state: "succeeded"; result: { deleted: true; owner: string; repo: string } }
  | { state: "failed" | "outcome_unknown"; error: { code: SafeErrorCode; message: string; retryable: boolean } };
type ProgressEvent = { sequence: number; atMs: number; phase: string; message: string; repoId?: string };
type JobStatus =
  | { kind: "acquisition"; jobId: string; firstSequence: number; nextSequence: number; truncated: boolean; windowError: "events_expired" | null; events: readonly ProgressEvent[]; status: AcquisitionStatus }
  | { kind: "fork_cleanup"; jobId: string; firstSequence: number; nextSequence: number; truncated: boolean; windowError: "events_expired" | null; events: readonly ProgressEvent[]; status: ForkCleanupStatus }
  | { kind: "finish"; jobId: string; firstSequence: number; nextSequence: number; truncated: boolean; windowError: "events_expired" | null; events: readonly ProgressEvent[]; status: FinishStatus };
```

`ProgressEvent.phase` is one of the acquisition phases above, `fork_cleanup_preflight | fork_cleanup_delete | fork_cleanup_reconcile`, or `finish_commit | finish_push | finish_pr | finish_merge | finish_lifecycle`; `warnings`, `blockers`, and `events` are capped at 16, 16, and 256 entries; warning/progress messages are capped at 512 bytes. `afterSequence` is optional, non-negative, and at most `Number.MAX_SAFE_INTEGER`; when it predates the retained ring, return `truncated:true`, `windowError:"events_expired"`, the current `firstSequence`, and retained events without replaying the mutation. A preview may durably persist its private binding record but performs no destination, repository, or remote mutation; it is bound to operation ID, source, action, root/destination, authenticated account, repository-registry revision, and a canonical payload digest, expires after ten minutes, and execute revalidates every binding. Both acquisition/fork-cleanup execute and finish return `{ jobId }` and existing job IDs return the same job. Extend the existing Increment 2 `WorkspaceReview`/`RepositoryReview`. A repository review includes only repo ID/alias/label, branch/base revision, dirty state, ahead/behind, bounded diff, test summaries supplied by the session, remote/tracking/push state, and conflicts. A finish result is independently `pending | running | succeeded | failed | outcome_unknown`; never collapse multi-repo results into one boolean.

- [ ] **Step 4: Run tests/typecheck**

Run: `pnpm --filter @t4-code/protocol test -- desktop-ipc.test.ts peer-wire.test.ts && pnpm --filter @t4-code/protocol typecheck`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/protocol/src/desktop-ipc.ts packages/protocol/test/desktop-ipc.test.ts packages/protocol/src/peer-wire.ts packages/protocol/test/peer-wire.test.ts
git commit -m "feat: define acquisition and finish protocols"
```

### Task 2: Add a credential-safe GitHub CLI adapter

**Files:**
- Create: `apps/desktop/src/github-runner.ts`
- Create: `apps/desktop/test/github-runner.test.ts`
- Create: `apps/desktop/src/github-repository.ts`
- Create: `apps/desktop/test/github-repository.test.ts`

- [ ] **Step 1: Write failing adapter tests**

Inject the spawn function and test `gh auth status`, `gh repo view owner/repo --json ...`, `gh repo fork owner/repo --clone=false`, `gh pr create --repo ... --head ... --base ...`, bounded all-state PR listing, `gh api --paginate repos/<fork>/branches?per_page=100`, cross-fork compare calls, and explicitly confirmed `gh repo delete owner/repo --yes`. Assert argv plus `shell:false`, 30-second default/5-minute maximum, abort handling, 1 MiB output cap, structured JSON parsing, token/authorization/credential-helper redaction, sanitized environment, no pasted URL execution, and exact safe codes: `github_auth_required`, `github_forbidden`, `github_network`, `github_conflict`, `github_outcome_unknown`, `github_failed`.

- [ ] **Step 2: Run tests and verify failure**

Run: `pnpm --filter @t4-code/desktop test -- github-runner.test.ts github-repository.test.ts`

Expected: FAIL because the modules are missing.

- [ ] **Step 3: Implement `GitHubRunner` and `GitHubRepository`**

Construct canonical `owner/repo` values from parsed fields. Pass credentials only through the desktop user's existing `gh`/Git configuration. Parse JSON into safe account/repo/fork/PR/branch/compare records and discard raw output after the bounded operation. Branch enumeration stops at 32 entries and reports the limit rather than silently truncating. Mark a disconnect after sending a fork/PR/delete request but before parsing the result as `outcome_unknown`, requiring remote reconciliation by slug/head branch or fork absence before retry. Expose repository deletion only through the fork-cleanup service after its identity/blocker/confirmation checks; no generic delete method crosses IPC or peer boundaries.

- [ ] **Step 4: Run tests**

Run: `pnpm --filter @t4-code/desktop test -- github-runner.test.ts github-repository.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/github-runner.ts apps/desktop/test/github-runner.test.ts apps/desktop/src/github-repository.ts apps/desktop/test/github-repository.test.ts
git commit -m "feat: add safe GitHub desktop adapter"
```

### Task 3: Implement idempotent use/clone/fork acquisition

**Files:**
- Create: `apps/desktop/src/repository-acquisition.ts`
- Create: `apps/desktop/test/repository-acquisition.test.ts`
- Create: `apps/desktop/src/fork-cleanup.ts`
- Create: `apps/desktop/test/fork-cleanup.test.ts`
- Modify: `apps/desktop/src/repository-git.ts`
- Modify: `apps/desktop/test/repository-git.test.ts`
- Modify: `apps/desktop/src/workspace-manifest.ts`
- Modify: `apps/desktop/test/workspace-manifest.test.ts`
- Modify: `apps/desktop/src/workspace-recovery.ts`
- Modify: `apps/desktop/test/workspace-recovery.test.ts`
- Modify: `apps/desktop/src/lifecycle.ts`
- Modify: `apps/desktop/test/lifecycle-runtime.test.ts`
- Modify: `apps/desktop/src/repository-registry.ts`
- Modify: `apps/desktop/test/repository-registry.test.ts`

- [ ] **Step 1: Write failing preview tests**

Test matching registered clones by normalized GitHub remote; previewing use-existing, clone, or fork; approved destination root labels; existing destination conflicts; authentication/account restrictions; and safe path-free projections. Preview must perform no local/remote mutation.

- [ ] **Step 2: Write failing execution/recovery tests**

Verify a durable `planned` acquisition manifest and same-filesystem hidden staging parent with an owner-only nonce marker precede clone/fork; replay of the same operation ID returns the same result; changed replay is rejected; clone lands only under an approved root and is atomically renamed from staging after validation; fork creates/reuses the authenticated fork only when `gh repo view` proves its parent/source identity matches the requested source; fork clone configures fork as `origin` and source as `upstream`; remotes are verified after mutation; rollback removes only a staging/final destination whose nonce marker matches; a user-created destination race is preserved; external forks are recorded but never auto-deleted by acquisition rollback; unknown fork outcome reconciles before retry; and distinct auth/forbidden/destination/remote/network errors survive as safe codes.

Use this executable staging layout: create `<approved-root>/.t4-acquire-<operationId>/`, fsync an owner-only `owner.json` containing operation ID/nonce/destination digest, and pass the still-nonexistent child `checkout/` to `git clone`. After clone validation, write and fsync the same ownership record at `checkout/.git/t4-owned.json`, fsync `checkout/.git`, then atomically rename `checkout/` to the final destination and fsync the approved root. The moved `.git/t4-owned.json` is the final-destination ownership proof; only then remove the empty staging parent.

Test this exact recovery matrix: `planned` + no local evidence resumes the next step; `fork_requested` + matching remote fork records `fork_confirmed`, absent fork retries only while GitHub is reachable, and unreachable lookup holds `outcome_unknown`; `fork_confirmed` resumes clone; staging parent with matching marker and absent/partial `checkout/.git` removes only that parent then reclones; validated checkout with both matching markers resumes remote verification/rename; final destination with matching moved marker resumes remote verification/registration; final destination without the marker is a preserved `destination_exists` race; `clone_renamed`/`remotes_verified` with a registered matching remote returns the recorded repo, otherwise resumes registration; `registered` returns the durable result. Any marker/digest mismatch is held for user recovery, never cleaned.

At `fork_confirmed`, fsync a private `ForkRecord` with opaque `forkRecordId`, acquisition operation ID, account, fork/source identities, creation/reuse flag, and optional registered repo ID; this happens before clone begins so a later orphan remains addressable. Also test a separate `ForkCleanup` preview/execute keyed by `forkRecordId`: only a record proving this acquisition created the fork is eligible; a reused/pre-existing fork always returns `not_t4_owned` and can never reach delete. Preview exposes `t4Created`, revalidates the recorded fork parent/source identity, lists open PRs, enumerates at most 32 fork branches, and for each calls the GitHub compare API with the fork branch head as base and the source default branch as head. Only `ahead` or `identical` proves the fork head is contained upstream; `behind`/`diverged` produces `unmerged_branch`, more than 32 branches produces `branch_limit`, and any incomplete/unreachable comparison produces `comparison_unknown`. Execute requires a ten-minute preview plus confirmation bound to account/fork/source/exact open-PR list/branch-head/comparison snapshot. Immediately before `gh repo delete`, it repeats the authoritative parent identity, ownership record, open-PR query, complete branch enumeration, every head SHA, and every containment comparison; any drift or unavailable check rejects `preview_changed` and requires a fresh preview. It refuses while any blocker exists, invokes deletion once, and reconciles an unknown outcome with `gh repo view` before any retry. This intentionally conservative proof can refuse deletion that a human may judge safe. Acquisition cancellation/rollback never calls it.

- [ ] **Step 3: Run tests and verify failure**

Run: `pnpm --filter @t4-code/desktop test -- repository-acquisition.test.ts fork-cleanup.test.ts repository-git.test.ts workspace-manifest.test.ts workspace-recovery.test.ts repository-registry.test.ts lifecycle-runtime.test.ts`

Expected: FAIL because acquisition is missing.

- [ ] **Step 4: Implement `RepositoryAcquisition`**

Serialize by operation ID and destination root. Extend `RepositoryGit` with injected argv-only `clone(source,destination)`, `listRemotes(repo)`, `setRemote(repo,name,url)`, and `removeRemote(repo,name)` methods, each with path/timeout/output bounds and exact tests; use those methods for clone/remote setup, `GitHubRepository` for account mutations, and `RepositoryRegistry` for final registration. Implement the two-marker staging transfer above; journal `fork_requested`, the durable `ForkRecord`, `fork_confirmed`, `clone_staged`, `clone_renamed`, `remotes_verified`, and `registered` durably before the next mutation. Put T4-created ownership enforcement, immediate authoritative revalidation, confirmation, blocker proof, deletion, and reconciliation in the separate `ForkCleanup` service. Extend `WorkspaceRecovery` and construct the acquisition/fork-cleanup reconcilers in `DesktopLifecycle` startup. Fork cleanup is never part of rollback.

- [ ] **Step 5: Run tests**

Run: `pnpm --filter @t4-code/desktop test -- repository-acquisition.test.ts fork-cleanup.test.ts repository-git.test.ts workspace-manifest.test.ts workspace-recovery.test.ts repository-registry.test.ts lifecycle-runtime.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/repository-acquisition.ts apps/desktop/test/repository-acquisition.test.ts apps/desktop/src/fork-cleanup.ts apps/desktop/test/fork-cleanup.test.ts apps/desktop/src/repository-git.ts apps/desktop/test/repository-git.test.ts apps/desktop/src/workspace-manifest.ts apps/desktop/test/workspace-manifest.test.ts apps/desktop/src/workspace-recovery.ts apps/desktop/test/workspace-recovery.test.ts apps/desktop/src/lifecycle.ts apps/desktop/test/lifecycle-runtime.test.ts apps/desktop/src/repository-registry.ts apps/desktop/test/repository-registry.test.ts
git commit -m "feat: acquire GitHub repositories safely"
```

## Chunk 2: Review and Finish Transactions

### Task 4: Extend the bounded multi-repository review snapshots

**Files:**
- Modify: `apps/desktop/src/multi-repo-status.ts`
- Modify: `apps/desktop/test/multi-repo-status.test.ts`
- Modify: `apps/desktop/src/repository-git.ts`
- Modify: `apps/desktop/test/repository-git.test.ts`

- [ ] **Step 1: Write failing review tests**

Using temporary repos, assert per-repo branch/base, dirty/clean, ahead/behind, the committed task-branch diff from immutable base commit through `HEAD`, staged and unstaged changes layered on top, tracking/push state, conflicts, and session-provided test summaries. Cap each repository diff at 2 MiB with an explicit truncation flag and the whole review payload at 3 MiB before its envelope; then UTF-8 encode the final peer frame and deterministically truncate repository diffs until its byte length is at most `MAX_FRAME_BYTES - 65536`, reserving 64 KiB for transport framing. Cap diagnostic fields at 512 bytes. Convert known worktree prefixes in structured metadata to `repo://alias/...`; redact credentials; return a safe error for a missing worktree instead of falling back to the base checkout.

- [ ] **Step 2: Run tests and verify failure**

Run: `pnpm --filter @t4-code/desktop test -- multi-repo-status.test.ts repository-git.test.ts`

Expected: FAIL because Increment 2 review lacks full diff/test/remote/conflict fields and limits.

- [ ] **Step 3: Implement read-only review**

Extend the existing `MultiRepoStatus` authority: read the active manifest, revalidate every owned worktree, diff the immutable base commit against `HEAD` before collecting index/worktree changes, run only read-only Git commands, and preserve per-repo errors so one unavailable repo does not hide the others. Never mutate, fetch, or contact GitHub during review. Do not create a competing review service or protocol operation.

- [ ] **Step 4: Run tests**

Run: `pnpm --filter @t4-code/desktop test -- multi-repo-status.test.ts repository-git.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/multi-repo-status.ts apps/desktop/test/multi-repo-status.test.ts apps/desktop/src/repository-git.ts apps/desktop/test/repository-git.test.ts
git commit -m "feat: review multi-repository workspaces"
```

### Task 5: Implement commit, push, and pull-request finish actions

**Files:**
- Create: `apps/desktop/src/workspace-finish.ts`
- Create: `apps/desktop/test/workspace-finish.test.ts`
- Modify: `apps/desktop/src/workspace-manifest.ts`
- Modify: `apps/desktop/test/workspace-manifest.test.ts`
- Modify: `apps/desktop/src/workspace-recovery.ts`
- Modify: `apps/desktop/test/workspace-recovery.test.ts`
- Modify: `apps/desktop/src/lifecycle.ts`
- Modify: `apps/desktop/test/lifecycle-runtime.test.ts`

- [ ] **Step 1: Write failing per-repo finish tests**

Test explicit commit messages; `git add -A -- .` stages tracked deletions/modifications plus untracked non-ignored files only inside that worktree; clean/no-op commit; hook failure; explicit push to the manifest-verified `origin`; exact refspec `refs/heads/<branch>:refs/heads/<branch>`; `--set-upstream` only on first push; force-push flags never used; cached remote collision; non-fast-forward; auth/network failure; cross-fork PR create/reconcile with `owner:branch`; operation-ID replay; interruption/outcome unknown across desktop restart; and two-repo partial success where repo A remains succeeded while repo B retries. Assert no rollback of successful remote mutations and no automatic merge.

- [ ] **Step 2: Run tests and verify failure**

Run: `pnpm --filter @t4-code/desktop test -- workspace-finish.test.ts workspace-manifest.test.ts`

Expected: FAIL because the finish service is missing.

- [ ] **Step 3: Implement a resumable per-repo action ledger**

Validate the current worktree/branch/base and manifest-verified remote roles before each action. Before commit, record the expected parent, staged tree ID after `git add -A -- .`, cleaned message digest, and hook policy; an unknown commit succeeds only when HEAD has that exact parent/tree/message, otherwise it is held. Push only the current task branch to `origin` with the explicit same-name refspec and never force. Before push, record the expected local commit and previously observed exact remote branch ref; reconcile as succeeded only when `git ls-remote --heads origin refs/heads/<branch>` equals the expected commit, then repair missing upstream tracking idempotently; retry only when it still equals the preflight ref/absence, and fail `remote_advanced` otherwise. Record `pending -> running -> succeeded | failed | outcome_unknown` durably per repo/action. Reconcile PRs with `gh pr list --repo baseOwner/baseRepo --head forkOwner:branch --base target --state all --json number,url,state,headRefName,baseRefName`; zero matches permits retry only when the preceding push is proven, one exact match succeeds regardless of open/closed/merged state, and multiple exact matches return `github_conflict` for user selection rather than choosing arbitrarily.

Persist this restart matrix and implement its owner in `WorkspaceRecovery`, invoked by `DesktopLifecycle` before accepting requests: commit `running/outcome_unknown` reconciles exact parent/tree/message or holds; push reconciles exact remote ref as succeeded, unchanged preflight as retryable, advanced ref as `remote_advanced`, and unreachable as held; PR reconciles with the all-state/ambiguity rules above; completed actions remain immutable; failed retryable actions resume only through the same operation ID. Recovery emits durable typed job descriptors; Task 7 loads those descriptors into `WorkspaceJobRegistry` so `job.status` reports them without mutation replay.

- [ ] **Step 4: Run tests**

Run: `pnpm --filter @t4-code/desktop test -- workspace-finish.test.ts workspace-manifest.test.ts workspace-recovery.test.ts lifecycle-runtime.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/workspace-finish.ts apps/desktop/test/workspace-finish.test.ts apps/desktop/src/workspace-manifest.ts apps/desktop/test/workspace-manifest.test.ts apps/desktop/src/workspace-recovery.ts apps/desktop/test/workspace-recovery.test.ts apps/desktop/src/lifecycle.ts apps/desktop/test/lifecycle-runtime.test.ts
git commit -m "feat: finish workspaces with commit push and PR"
```

### Task 6: Implement safe local merge, archive, keep, and discard

**Files:**
- Create: `apps/desktop/src/workspace-merge.ts`
- Create: `apps/desktop/test/workspace-merge.test.ts`
- Modify: `apps/desktop/src/workspace-finish.ts`
- Modify: `apps/desktop/test/workspace-finish.test.ts`
- Modify: `apps/desktop/src/workspace-recovery.ts`
- Modify: `apps/desktop/test/workspace-recovery.test.ts`

- [ ] **Step 1: Write failing detached-integration merge tests**

When the target is not checked out, verify: immutable preflight target and source commits; detached temporary integration worktree; merge of the recorded source commit (never the moving branch name); immediate recheck that the target remains unchecked before compare-and-swap; merge success; atomic `git update-ref <target> <merged> <preflight>` compare-and-swap; cleanup; conflict abort/removal; and CAS failure leaving the target ref unchanged. No base checkout may be edited.

- [ ] **Step 2: Write failing user-checkout merge tests**

When the target is checked out, require an explicit confirmation token bound to repo/opaque checkout ID/safe checkout label/target/preflight target and source commits, revalidate that the same checkout still owns the target and has a clean index/worktree immediately before merging the recorded source commit, merge only there, run `git merge --abort` on conflict, and surface `merge_abort_failed` with recovery guidance if abort fails. The canonical checkout path stays desktop-private. Tests must prove no background ref movement without confirmation.

- [ ] **Step 3: Write failing keep/archive/discard tests**

Test the top-level lifecycle action across all repositories. `keep` retains every branch/worktree after per-repo publish/merge steps. `archive` first archives the one OMP session, then removes each clean owned worktree and preserves every branch; any dirty repo remains recoverable with a per-repo incomplete result. `discard` requires one workspace-bound confirmation, closes/archives the session, then removes every nonce-owned worktree/branch, never remote branches or pre-existing refs. If the OMP outcome is unknown, all cleanup is held. Cleanup failures persist per repo as retryable `cleaning`; startup recovery resumes them idempotently.

Exercise the exact merge crash matrix: journal before integration-worktree creation, then remove a matching empty/partial integration worktree or resume from its validated marker; after merge completion record merged commit before ref mutation; an unknown `update-ref` succeeds only when target equals recorded merged commit, retries only when target equals preflight, and otherwise reports CAS conflict; cleanup interruption removes only the nonce-matching integration worktree; a confirmed user-checkout interruption inspects `MERGE_HEAD` plus target/source commits, resumes abort for a conflict, reports success when HEAD is the recorded merge result, and otherwise holds `user_checkout_recovery_required` without touching user files. Recheck target checkout ownership immediately before `update-ref` and fail safely if a checkout appeared.

- [ ] **Step 4: Run tests and verify failure**

Run: `pnpm --filter @t4-code/desktop test -- workspace-merge.test.ts workspace-finish.test.ts workspace-recovery.test.ts`

Expected: FAIL because merge/lifecycle actions are missing.

- [ ] **Step 5: Implement merge and lifecycle actions**

Put Git merge mechanics in `WorkspaceMerge`; keep action orchestration/ledger in `WorkspaceFinish`; implement the crash matrix in `WorkspaceRecovery` and run it during `DesktopLifecycle` startup. Use argv-only commands, merge immutable recorded commits, and journal each integration/owned worktree and ref-mutation boundary before continuing.

- [ ] **Step 6: Run tests**

Run: `pnpm --filter @t4-code/desktop test -- workspace-merge.test.ts workspace-finish.test.ts workspace-recovery.test.ts`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/desktop/src/workspace-merge.ts apps/desktop/test/workspace-merge.test.ts apps/desktop/src/workspace-finish.ts apps/desktop/test/workspace-finish.test.ts apps/desktop/src/workspace-recovery.ts apps/desktop/test/workspace-recovery.test.ts
git commit -m "feat: add safe workspace merge and cleanup"
```

## Chunk 3: Job Wiring, Shared UX, and Artifacts

### Task 7: Wire acquisition/review/finish through desktop and direct peer

**Files:**
- Create: `apps/desktop/src/workspace-job-registry.ts`
- Create: `apps/desktop/test/workspace-job-registry.test.ts`
- Modify: `apps/desktop/src/ipc.ts`
- Modify: `apps/desktop/test/ipc-lifecycle.test.ts`
- Modify: `apps/desktop/src/preload.ts`
- Modify: `packages/client/src/desktop-runtime-contracts.ts`
- Modify: `packages/client/test/desktop-runtime.test.ts`
- Modify: `apps/desktop/src/lifecycle.ts`
- Modify: `apps/desktop/test/lifecycle-runtime.test.ts`
- Modify: `apps/desktop/src/peer-share.ts`
- Modify: `apps/desktop/test/peer-share.test.ts`
- Modify: `apps/web/src/platform/peer-transport.ts`
- Modify: `apps/web/test/peer-transport.test.ts`
- Modify: `apps/web/src/platform/browser-shell-port.ts`
- Modify: `apps/web/test/browser-platform.test.ts`

- [ ] **Step 1: Write failing boundary tests**

Assert `WorkspaceJobRegistry` durably routes job IDs to exactly one acquisition, fork-cleanup, or finish authority, persists typed results plus a 256-event sequence ring, caps retention according to the manifest policy, and returns events after `afterSequence` including the defined `events_expired` truncation response. Also assert trusted/authorized callers, live opaque root/repository/workspace/preview ID authorization, preview expiry/binding, idempotency, serialization by workspace/repo, confirmation binding, safe partial results, disconnect/reconnect status, handler removal, and no absolute paths/credentials/raw Git output in IPC or peer frames.

- [ ] **Step 2: Run tests and verify failure**

Run: `pnpm --filter @t4-code/desktop test -- workspace-job-registry.test.ts ipc-lifecycle.test.ts lifecycle-runtime.test.ts peer-share.test.ts && pnpm --filter @t4-code/client test -- desktop-runtime.test.ts && pnpm --filter @t4-code/web test -- peer-transport.test.ts browser-platform.test.ts`

Expected: FAIL because the services are not wired.

- [ ] **Step 3: Wire desktop services and shell methods**

Construct `WorkspaceJobRegistry`, acquisition/fork-cleanup, existing `MultiRepoStatus`, and finish services once in `DesktopLifecycle`; load persisted jobs and run their recovery/reconciliation before serving IPC or peer requests; register every new acquisition/fork-cleanup/finish job before starting it; expose optional typed shell methods through IPC/preload/client; dispatch peer operations only after direct HyperDHT authorization; and make reconnect use `job.status` rather than replay.

- [ ] **Step 4: Run tests/typechecks**

Run: `pnpm --filter @t4-code/desktop test -- workspace-job-registry.test.ts ipc-lifecycle.test.ts lifecycle-runtime.test.ts peer-share.test.ts && pnpm --filter @t4-code/client test -- desktop-runtime.test.ts && pnpm --filter @t4-code/web test -- peer-transport.test.ts browser-platform.test.ts && pnpm typecheck`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/workspace-job-registry.ts apps/desktop/test/workspace-job-registry.test.ts apps/desktop/src/ipc.ts apps/desktop/test/ipc-lifecycle.test.ts apps/desktop/src/preload.ts packages/client/src/desktop-runtime-contracts.ts packages/client/test/desktop-runtime.test.ts apps/desktop/src/lifecycle.ts apps/desktop/test/lifecycle-runtime.test.ts apps/desktop/src/peer-share.ts apps/desktop/test/peer-share.test.ts apps/web/src/platform/peer-transport.ts apps/web/test/peer-transport.test.ts apps/web/src/platform/browser-shell-port.ts apps/web/test/browser-platform.test.ts
git commit -m "feat: expose acquisition and finish workflows"
```

### Task 8: Build shared acquisition and review/finish UX

**Files:**
- Create: `apps/web/src/features/repositories/GitHubAcquisitionDialog.tsx`
- Create: `apps/web/src/features/repositories/ForkCleanupDialog.tsx`
- Modify: `apps/web/src/features/mobile-tasks/MultiRepoReview.tsx`
- Modify: `apps/web/src/features/panes/ReviewPane.tsx`
- Create: `apps/web/src/features/review/FinishWorkspaceDialog.tsx`
- Create: `apps/web/src/features/review/finish-workspace-store.ts`
- Create: `apps/web/test/github-acquisition-flow.test.tsx`
- Create: `apps/web/test/workspace-review-flow.test.tsx`
- Create: `apps/web/test/finish-workspace-store.test.ts`
- Modify: `apps/web/test/panes-review.test.ts`
- Modify: `apps/web/src/features/new-task/RepositoryPicker.tsx`
- Modify: `apps/web/src/features/mobile-tasks/MobileTaskLauncher.tsx`
- Modify: `apps/web/src/features/mobile-tasks/MobileTaskFeed.tsx`
- Modify: `apps/web/src/router.tsx`

- [ ] **Step 1: Write failing acquisition UI tests**

Cover `owner/repo` plus `https://github.com/owner/repo` and `https://github.com/owner/repo.git` input. Parse supported URLs in renderer-only `parseGitHubSourceInput()` into bounded owner/repo fields before protocol submission. Reject credentials, ports, non-HTTPS, non-GitHub hosts, extra path components, query/fragment, malformed encoding, trailing-hyphen owners, and invalid repo names. Then cover use-existing/clone/fork previews, approved root choice, clear network/account mutation labeling, explicit execute, progress via `job.status`, safe errors, reconnect status, and no arbitrary mobile directory browsing. Cover fork-cleanup as a separate advanced action that displays source/fork identity and blockers, requires preview plus typed confirmation, never appears as acquisition rollback, and reconciles unknown deletion status before retry.

- [ ] **Step 2: Write failing review/finish UI tests**

Extend the existing unified review surface and cover one tab per repo; primary label; diff/truncation; ahead/behind/tests/remotes/conflicts; tab switching that preserves each repo's scroll/action state; exact per-repo publish/merge pipelines; one workspace-level keep/archive/discard choice; destructive confirmation; user-checkout merge confirmation; partial success/targeted retry; outcome-unknown reconciliation; and no auto-merge/default remote deletion. Test 44px mobile controls and offline read-only cache behavior. In `panes-review.test.ts`, prove the desktop session Review pane renders `MultiRepoReview` for a multi-repo workspace; in `workspace-review-flow.test.tsx`, prove a mobile task card routes to that same component and preserves the same per-repo state contract.

- [ ] **Step 3: Run tests and verify failure**

Run: `pnpm --filter @t4-code/web test -- github-acquisition-flow.test.tsx workspace-review-flow.test.tsx finish-workspace-store.test.ts`

Expected: FAIL because the screens/stores are missing.

- [ ] **Step 4: Implement shared responsive flows**

Reuse the same safe shell methods on desktop/mobile. Parse accepted GitHub source text locally and send only `{ owner, repo }`. Require preview before acquisition or fork-cleanup execute. Keep action and scroll state per repo, preserve them across tabs, surface partial results, poll `job.status` after reconnect, and embed the existing `MultiRepoReview` in `ReviewPane` for desktop sessions while mobile task cards navigate to that exact shared component.

- [ ] **Step 5: Run tests/typecheck**

Run: `pnpm --filter @t4-code/web test -- github-acquisition-flow.test.tsx workspace-review-flow.test.tsx finish-workspace-store.test.ts mobile-touch-targets.test.tsx && pnpm --filter @t4-code/web typecheck`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/features/repositories apps/web/src/features/review apps/web/test/github-acquisition-flow.test.tsx apps/web/test/workspace-review-flow.test.tsx apps/web/test/finish-workspace-store.test.ts apps/web/src/features/new-task/RepositoryPicker.tsx apps/web/src/features/mobile-tasks/MobileTaskLauncher.tsx apps/web/src/features/mobile-tasks/MobileTaskFeed.tsx apps/web/src/features/mobile-tasks/MultiRepoReview.tsx apps/web/src/features/panes/ReviewPane.tsx apps/web/test/panes-review.test.ts apps/web/src/router.tsx
git commit -m "feat: add acquisition review and finish UX"
```

### Task 9: Verify, package, and produce test artifacts

**Files:**
- Create: `scripts/repository-workflow-acceptance.mjs`
- Create: `scripts/repository-workflow-acceptance.test.mjs`
- Modify only explicit fixes found during verification after the script is committed.

- [ ] **Step 1: Write and test a disposable local acceptance harness**

The harness creates its own temp approved root, two repos, local bare remotes, conflict branches, and evidence directory. Its test injects Git/T4 drivers and asserts cleanup plus nonzero exit on any invariant violation.

Run: `node --test scripts/repository-workflow-acceptance.test.mjs`

Expected: PASS.

Commit the verified harness immediately, before full verification can require any implementation fixes:

```bash
git add scripts/repository-workflow-acceptance.mjs scripts/repository-workflow-acceptance.test.mjs
git commit -m "test: add repository workflow acceptance harness"
```

- [ ] **Step 2: Run focused and full checks**

Run: `pnpm --filter @t4-code/protocol test && pnpm --filter @t4-code/client test && pnpm --filter @t4-code/desktop test && pnpm --filter @t4-code/web test && pnpm check && pnpm build:web && pnpm build:desktop`

Expected: PASS. Modify only explicit implementation or test files needed for a discovered failure; keep those changes unstaged until the final verification-fixes step.

- [ ] **Step 3: Run local disposable-repository acceptance**

Run: `node scripts/repository-workflow-acceptance.mjs --evidence /private/tmp/t4-repository-acceptance`

The harness exercises two repos through commit, one successful push with a local bare remote, one rejected push, detached integration merge success/conflict/CAS race, confirmed user-checkout merge conflict/abort, archive of clean work, refusal to archive dirty work, and discard. It writes before/after `show-ref.txt`, `worktrees.txt`, `status.txt`, `remote-refs.txt`, and `result.json` beneath `/private/tmp/t4-repository-acceptance`. Expected: `result.json` has `ok:true`; selected per-repo results match; no pre-existing ref/worktree/status line changes.

- [ ] **Step 4: Pause for live GitHub mutation approval**

Report the authenticated account name, disposable source/fork slugs, intended fork/push/PR operations, and cleanup limitations without revealing credentials. Stop and ask the user for explicit approval. Do not run any fork, push, or PR command until the user replies with approval for this checkpoint.

- [ ] **Step 5: Run the approved live GitHub acceptance**

Using only the approved disposable target, save safe evidence to `/private/tmp/t4-github-acceptance/result.json`: preview then explicitly execute fork/clone, push a test branch, and open a PR; query `gh repo view ... --json nameWithOwner,parent` and `gh pr list ... --json number,url,state,headRefName,baseRefName`; verify `origin` is the fork, `upstream` is the source, parent identity matches, reconnect/replay does not duplicate the fork/PR, and no credentials or paths appear in peer diagnostics. Expected: exactly one fork and one open PR recorded.

- [ ] **Step 6: Build, inspect, and install the desktop app**

Run: `pnpm package:mac:unsigned && pnpm inspect:dmg -- release/T4-Code-0.1.11-mac-arm64.dmg`

Expected: unsigned DMG builds, mounts read-only, and passes ASAR inspection. Before install, run `pgrep -lf 'T4 Code.app/Contents/MacOS'`. If running, stop for approval, request normal quit with `osascript -e 'tell application "T4 Code" to quit'`, poll until `pgrep` is empty, and stop again for explicit approval before any forced termination if it does not exit. If `~/Applications/T4 Code.app` exists, compare its bundle version and stop for explicit overwrite approval. After approval and confirmed process exit, move the old bundle to a timestamped `~/Applications/T4 Code.app.backup-<timestamp>`; never overlay it. Copy the built `release/mac-arm64/T4 Code.app` into a new same-directory temporary bundle `~/Applications/.T4 Code.app.installing-<operationId>` with `ditto`, verify its bundle and executable, then rename it to `~/Applications/T4 Code.app`. If copy/verification/rename fails, preserve evidence and restore the backup only when the final path is absent. Every write, move, quit, or forced termination outside the worktree requires the corresponding execution-time approval/escalation. Then run `open "$HOME/Applications/T4 Code.app"`, capture `pgrep` output in `/private/tmp/t4-desktop-package-pid.txt`, and verify the packaged app reopens the acquired workspace.

- [ ] **Step 7: Build, install, and verify the Android APK**

Run: `pnpm --filter @t4-code/mobile build:android:debug && shasum -a 256 apps/mobile/android/app/build/outputs/apk/debug/app-debug.apk && adb install -r apps/mobile/android/app/build/outputs/apk/debug/app-debug.apk && adb shell am force-stop com.lycaonsolutions.t4code && adb shell monkey -p com.lycaonsolutions.t4code 1`

Save the SHA-256 and `adb logcat -d -v threadtime -t 2000` to `/private/tmp/t4-android-acceptance/`, redacting known workspace prefixes and credential-like fields. At a blocking human checkpoint, complete direct HyperDHT acquire/launch/review, toggle networking, force-stop/relaunch, and confirm the same safe workspace/session/job IDs against the packaged desktop. Do not continue or claim artifact verification until the user completes this checkpoint. Expected: flow succeeds with no hosted server/relay fallback and no duplicate acquisition/initial prompt/finish job.

- [ ] **Step 8: Commit verification-only fixes**

The harness was committed in Step 1. List changes with `git status --short`; stage only explicit files changed to fix later verification failures and commit with `git commit -m "test: verify acquisition and finish lifecycle"`. If no additional fix was required, do not create an empty second commit.
