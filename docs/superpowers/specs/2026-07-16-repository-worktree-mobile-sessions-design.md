# Repository-Scoped Worktree Sessions and Mobile Task Launcher

## Purpose

Make T4 Code feel like a local-first, serverless counterpart to the best Claude Code desktop/mobile workflow:

- Select one or more repositories before starting work.
- Choose a base branch per repository.
- Start every new coding task on an isolated branch and Git worktree derived from the task.
- Create, steer, review, and finish the same sessions from desktop or mobile.
- Let mobile request GitHub clone and fork workflows without exposing desktop credentials or filesystem paths.

Execution remains on the paired desktop through the existing direct HyperDHT connection. T4 must not add a hosted coordinator, relay, credential broker, or cloud execution service.

## Reference Behavior

The design adapts several current Claude Code interaction patterns while preserving T4's local architecture:

- Repository and branch selection before the first prompt, including multiple repositories for one task: <https://code.claude.com/docs/en/web-quickstart>
- One isolated Git worktree per parallel session: <https://code.claude.com/docs/en/desktop>
- Mobile steering of work that continues to run on the user's machine: <https://code.claude.com/docs/en/remote-control>
- Worktree-based isolation so parallel sessions cannot collide: <https://code.claude.com/docs/en/worktrees>

## Scope

This feature has three delivery increments:

1. Repository launcher and single-repository isolation.
2. Multi-repository scope and mobile parity.
3. GitHub acquisition and the complete review/finish lifecycle.

Each increment must be usable and verified. No increment may ship placeholder controls or fixture-only success.

Existing non-Git OMP sessions remain readable and usable. This feature does not remove T4's approved workspace roots or force historical sessions into worktrees.

## Architectural Ownership

### T4 desktop

T4 desktop owns repository and Git operations through three services.

#### Repository Registry

The registry stores approved repositories using opaque stable IDs. Its private record contains the canonical local path, display name, Git remote metadata, default/current branch, approved workspace root, and availability state.

The renderer and mobile peer receive only safe metadata:

- Opaque repository ID
- Display name
- Remote slug when one exists
- Current/default branch names
- Dirty/clean summary
- Local availability
- Whether T4 created or acquired the clone

Repository administration frames never contain absolute paths. Structured session data uses logical paths such as `repo://primary/src/main.ts`. Free-form OMP transcript, model prose, terminal output, and tool output are different: a remote peer with transcript/terminal capability may see host paths naturally printed by those streams. T4 replaces known registered-worktree prefixes with logical repo aliases in bounded structured logs and tool metadata, but does not claim perfect redaction of arbitrary free-form text. Mobile cannot submit host paths merely because one appeared in authorized session output.

The registry builds on the existing approved-workspace-root boundary. A local repository must canonicalize inside an approved root before it can be registered or used remotely.

#### Session Workspace Manager

The manager validates selected repositories and base refs, derives one session branch name, creates isolated worktrees, persists the workspace manifest, registers the workspace with OMP, and owns recovery/cleanup.

It never edits a user's base checkout. It operates only through Git's worktree and ref interfaces and through directories reserved for T4 session workspaces.

#### Repository Acquisition

The acquisition service accepts a GitHub slug or URL and supports:

- Use an already registered matching clone.
- Clone the source repository into an approved workspace root.
- Fork to the authenticated GitHub account, clone the fork, configure the fork as `origin`, and configure the source as `upstream`.

It uses the desktop's existing authenticated GitHub and Git setup. Credentials, tokens, SSH keys, and credential-helper output never enter renderer state, logs, peer frames, or mobile storage.

### OMP appserver

OMP remains authoritative for sessions, transcripts, prompts, models, approvals, tools, agents, and runtime state. It does not own Git acquisition or worktree lifecycle.

OMP receives an additive multi-root workspace capability:

1. The trusted local desktop backend registers a prepared primary worktree plus additional worktree roots.
2. Appserver returns an opaque workspace ID.
3. `session.create` accepts that workspace ID alongside the primary project ID.
4. The runtime treats every registered canonical root as workspace scope for read and write policy while keeping the primary root as `cwd` and the primary Git/LSP context.
5. The session persists the registered workspace roots locally so resume survives appserver restart.

Every registered root has a unique stable alias persisted with the session. Worktrees use a sibling layout:

```text
<t4-workspaces>/<workspace-id>/repos/<primary-alias>
<t4-workspaces>/<workspace-id>/repos/<secondary-alias>
```

OMP starts in the primary worktree. Additional repositories are reachable through stable relative paths such as `../shared-library`, and OMP's system workspace context lists each alias, relative path, repo ID, base revision, and branch. Structured tool/file events use `repo://<alias>/<relative-path>`. Aliases are sanitized from repository display names, collision-suffixed, and never changed when the session resumes.

The registration command requires a new local administrative capability and is not granted to ordinary proxied mobile commands. Mobile asks T4 to prepare a workspace through T4's typed peer protocol; it never calls OMP workspace registration directly.

OMP's first multi-root version may provide Git and LSP status only for the primary repository. Additional repositories remain fully accessible through their registered aliases and explicit `git -C`/path operations. The UI must state which repository is primary.

### Mobile

Mobile is a control surface over the authenticated direct peer. It may select approved repos, request acquisition, prepare workspaces, start sessions, steer work, approve actions, review changes, and request finish operations. All mutations execute on desktop.

## Isolation Model

Every selected repository receives a worktree before the first prompt. Although lazy creation would avoid unused worktrees, T4 cannot intercept OMP's exact first write safely because OMP executes tools directly. Eager preparation is therefore required for deterministic isolation.

Workspace preparation is journaled and transactional:

1. Resolve and canonicalize every repo.
2. Validate Git state and the selected base ref.
3. Fetch only when the requested ref requires it and the user initiated network work.
4. Derive and validate a branch name.
5. Find one collision-free branch name across all selected repositories.
6. Persist and fsync a `planned` job manifest containing the intended resources, immutable base commits, and a unique ownership nonce.
7. Create every branch and worktree beneath T4's workspace directory, atomically recording each completed mutation in the journal.
8. For a multi-repo workspace, register the complete root set with OMP and journal the registration ID. A single-repo Increment 1 session uses the existing project/session mechanism.
9. Create the OMP session and journal the reconciled session ID.

The manifest exists before the first local or remote mutation. Acquisition jobs use the same journal rule before cloning or requesting a fork. If any step before session creation fails, T4 rolls back only local branches, refs, clones, and worktrees whose ownership nonce is recorded by that job. The base checkout and pre-existing refs remain untouched. External GitHub mutations such as a newly created fork are recorded but never silently deleted during rollback; the UI offers a separate explicit cleanup action.

If OMP session creation has an unknown outcome, T4 enters `session_unknown`, performs no rollback, and reconciles against appserver before retrying or offering cleanup.

### Base refs

Each repository defaults to its current checked-out branch. The launcher exposes an editable base-branch selector.

The base is a committed ref. Dirty changes in the base checkout are not copied into the worktree. T4 shows a warning and the exact committed base revision, then lets the user cancel or explicitly continue. It never stashes, commits, or copies base changes implicitly.

### Branch naming

T4 derives a slug from the first prompt and previews it before submission, for example:

`t4/fix-hyperdht-reconnect`

The user may edit the preview. Names are sanitized and checked against local and remote refs in every selected repository. When the name exists anywhere, T4 chooses one numeric suffix that is free across the entire repo set, keeping the branch name consistent for the multi-repo task. Existing branches are never reset or reused implicitly.

Collision checks always include local refs and existing remote-tracking refs. The launcher offers **Refresh remote branches**; when enabled, T4 performs a bounded fetch before resolving bases and choosing the suffix. Without refresh, the UI labels remote collision state as cached and a later push may still report a newly created remote conflict.

## New Task Experience

Desktop and mobile use the same conceptual launcher.

### Composer

The composer contains:

- Repository pills above the prompt
- One repository marked Primary
- `+ Add repository`
- Base-branch selection per repository
- Safe status indicators for dirty, unavailable, fetching, or authentication-required state
- Model selection
- Permission mode, defaulting to Auto edits
- A large prompt field
- A generated branch-name preview with edit action

Auto edits apply only to registered worktree roots. Destructive commands, credential changes, publishing, external messages, and writes outside selected repos still require confirmation.

### Repository selection

`+ Add repository` offers:

- Approved local repositories
- Recently used repositories
- Clone or fork from GitHub

Mobile never browses arbitrary desktop directories. Desktop may add a local repository through a native folder picker, after which it becomes available to both clients.

### Preparation progress

Submitting the first prompt displays host-reported stages:

1. Validating repositories and authentication
2. Forking or cloning when requested
3. Resolving/fetching base refs
4. Creating worktrees and branches
5. Registering OMP workspace scope when multi-repo support is active
6. Starting the session

Failures preserve the prompt and selections, identify the failing repository and stage, and offer bounded retry or cancel. The agent does not start in a partially prepared workspace.

### Session feed

Mobile emphasizes a task feed containing:

- Running sessions with live phase, model, branch, repo set, and progress
- Waiting approvals and questions
- Recent sessions that reopen into the existing worktrees
- Connection health without making pairing controls dominate the screen
- Artifact links and review readiness

The session screen provides prompt steering, approvals, transcript, diffs, terminal/log access, model/thinking controls, and finish actions appropriate to the granted capability.

## GitHub Acquisition Flow

The user pastes a GitHub URL or `owner/repo`. T4 resolves public metadata and matching local registrations, then previews one of:

- **Use existing**: select an approved matching clone.
- **Clone**: choose an approved workspace root and clone there.
- **Fork to my account**: create or reuse the authenticated user's fork, clone it, set `origin` to the fork, and set `upstream` to the source.

The preview shows safe repo names, intended destination root label, remote roles, and whether a network/account mutation will occur. Execute requires an explicit user action.

GitHub is the only acquisition provider in this version. GitLab and generic remote acquisition are deferred; existing local clones from any Git provider can still be registered through desktop.

Acquisition is idempotent. Reconnecting or retrying with the same operation ID does not fork or clone twice. Existing destination directories, conflicting remote definitions, missing permissions, organization restrictions, authentication failures, and unavailable networks produce distinct actionable errors.

All Git/GitHub subprocesses execute with argument vectors and no shell. Parsed GitHub slugs must match bounded owner/repository rules; T4 constructs canonical remotes rather than executing a pasted URL. Refs reject leading-option forms and are validated with Git's ref validator, then resolved to immutable commits using end-of-options handling. Git commands use option termination where supported. Environment and subprocess output are bounded and sanitized before logging, and credential-helper or authorization output is never forwarded.

## Direct Peer Protocol

The authenticated peer protocol gains typed operations:

- `repo.list`
- `repo.branches.list`
- `repo.acquire.preview`
- `repo.acquire.execute`
- `workspace.prepare`
- `workspace.status`
- `workspace.cancel`
- `workspace.review`
- `workspace.finish`

Long operations return opaque job IDs and emit bounded progress events. Requests include idempotency keys and strict schemas. Reconnect resumes `workspace.status` from desktop authority rather than replaying mutation requests.

The protocol accepts repo IDs, GitHub slugs, branch refs, requested actions, and user-facing labels. It rejects absolute paths, shell fragments, unknown fields, oversized values, path separators in branch slugs where disallowed, and repo IDs not visible to the authenticated peer.

Cached mobile metadata is scoped to the paired desktop identity. Offline mode may display that safe cache, but all Git/session mutations remain disabled until the direct connection returns. There is no relay fallback.

### Cancellation states

Preparation uses explicit states:

- `planned`
- `acquiring`
- `preparing_worktrees`
- `registering_omp`
- `session_pending`
- `session_unknown`
- `active`
- `finishing`
- `cleaning`
- `complete`
- `failed`

`workspace.cancel` is valid only through `session_pending`. It requests subprocess cancellation, waits for the current atomic Git step to settle, and rolls back journal-owned local resources. During `registering_omp`, it also deregisters a confirmed unused OMP workspace. During `session_unknown`, cancellation is held until reconciliation determines whether a session exists. Once state is `active`, cancel is unavailable; the user must use the explicit stop/finish/archive lifecycle so a real session is never mistaken for failed preparation. External fork cleanup remains separate and explicit.

## Workspace Manifest and Recovery

Every prepared session has a versioned desktop-private manifest containing:

- OMP session ID when known
- T4 workspace ID and preparation job ID
- Selected repository IDs and primary repository ID
- Stable logical alias for every selected repository
- Canonical worktree locations
- Base branches and immutable base commits
- Created branch names
- Remote/acquisition metadata
- OMP registration ID
- Preparation, review, and cleanup state
- Created-resource ownership markers

The manifest/journal is created before mutation and is the recovery source of truth for reopening sessions, reconciling unknown outcomes, and cleaning up after crashes. Every state transition is written through a same-directory temporary file, fsynced, and renamed before the next mutation. Mobile receives only a safe projection.

Startup recovery scans incomplete manifests and reconciles Git worktrees, refs, acquisition destinations, and OMP sessions before offering retry or cleanup. T4 never guesses that a failed command did or did not mutate state.

## Review and Finish Lifecycle

**Review changes** displays one tab per repository with:

- Branch and base revision
- Dirty/clean state
- Commits ahead/behind
- Diff
- Relevant test results reported by the session
- Remote tracking and push state
- Conflicts or blocked operations

Desktop and mobile may request:

- Keep branches and worktrees
- Commit pending changes
- Push selected branches
- Open one pull request per changed repository
- Merge selected branches locally after a clean preflight
- Discard T4-owned branches/worktrees after explicit confirmation

Finish operations are per repository and resumable. A successful push or PR in one repository is not rolled back because another repository failed. T4 shows the partial result and offers targeted retry.

T4 never auto-merges. Local merge has two safe paths:

- If the target branch is not checked out elsewhere, T4 creates a temporary integration worktree, performs the merge there, and updates the target ref only when its old commit still matches the preflight value. Conflict aborts and removes the integration worktree.
- If the target branch is checked out in a user worktree, T4 refuses background ref movement. It may merge in that checkout only after an explicit confirmation that identifies the checkout and after verifying its index/worktree are clean. On conflict it immediately attempts `git merge --abort`; abort failure is surfaced with recovery instructions and the checkout is never reported clean.

The invariant that T4 never edits a base checkout applies to preparation and session work. The second local-merge path is an explicit finish action requested by the user. Discard removes only resources marked as created by the session and never deletes a remote branch by default.

Archiving does not silently delete work. Clean worktrees may be removed while preserving their branches; dirty worktrees stay recoverable until the user explicitly commits or discards. Cleanup failure remains visible and retryable.

## Git Repository Edge Cases

- Bare repositories are rejected as session repositories.
- Detached HEAD has no implicit base; the user must select a branch or commit, and creating a session branch from that immutable commit is explicit.
- Nested repositories are separate scope. Selecting a parent does not silently grant or prepare nested Git repositories.
- Submodules are not initialized or updated automatically in the first version. Existing checked-out submodule state is inherited according to normal Git worktree behavior; missing submodules are reported.
- Git LFS uses the desktop's installed Git/LFS configuration. Smudge/fetch failures are surfaced as acquisition/preparation failures; T4 does not implement an LFS client.
- Sparse-checkout repositories are preserved only when Git can create a worktree with valid sparse state. Unsupported or inconsistent sparse configurations fail preflight rather than expanding the checkout silently.

## Error Taxonomy

Errors are stable, bounded, and safe to display remotely:

- Repository unavailable or outside an approved root
- Not a Git repository
- Dirty base checkout warning
- Missing or ambiguous base ref
- Branch collision
- Worktree creation or rollback failure
- GitHub authentication required
- Fork forbidden or organization-restricted
- Clone destination conflict
- Remote configuration conflict
- Network unavailable
- OMP workspace registration unsupported or rejected
- OMP session outcome unknown
- Direct peer disconnected
- Review/merge conflict
- Cleanup incomplete

Messages contain safe repo names and stages, never raw credentials, command output containing tokens, or absolute desktop paths.

## Delivery Increments

### Increment 1: Repository launcher and single-repo isolation

- Repository registry on approved roots
- Desktop New Task launcher
- Base-branch selector and prompt-derived branch preview
- Transactional branch/worktree creation
- OMP session startup in the prepared primary worktree through the existing single-project/session mechanism; multi-root registration is not required in this increment
- Manifest persistence, reopen, recovery, and cleanup

### Increment 2: Multi-repo scope and mobile parity

- OMP appserver multi-root registration and persisted workspace scope
- Eager worktrees for every selected repo
- Typed direct-peer operations and progress jobs
- Mobile task launcher, task feed, reconnect, and cross-device resume
- Multi-repo status and review projection

### Increment 3: GitHub acquisition and finish lifecycle

- GitHub clone/fork preview and execution
- `origin`/`upstream` setup and conflict handling
- Diff review, commit, push, PR, local merge, archive, discard, and recovery
- Packaged desktop and Android artifacts

## Verification

### Service and Git tests

Temporary repositories prove:

- Registry canonicalization and approved-root enforcement
- Current/default/base branch resolution
- Prompt slug sanitization and cross-repo collision suffixing
- Worktree isolation from dirty base checkouts
- Atomic multi-repo preparation and rollback
- Crash/unknown-outcome reconciliation
- Reopen and cleanup
- Per-repo partial finish results

### Protocol and security tests

- Strict request/response and progress-event schemas
- Capability enforcement
- Idempotent replay and reconnect
- Cancellation boundaries
- Malformed input rejection
- No path, credential, token, or command leakage
- Mobile cache scoping by paired desktop identity

### OMP integration tests

- Workspace registration is local-admin only
- Primary and additional roots persist across appserver restart
- Auto-edit writes succeed inside every registered worktree
- Writes outside registered roots still require confirmation or fail
- Session resume uses the same worktrees
- Primary Git/LSP context remains stable

### Product tests

- Desktop launcher covers empty, ready, dirty, preparing, error, retry, cancel, and success states
- Mobile covers repo selection, branch choice, acquisition preview, preparation progress, disconnect/reconnect, steering, approval, review, and archive
- Android emulator completes the task flow and reconnects during preparation
- A real phone and desktop complete a direct HyperDHT create/steer/reopen/review flow
- Packaged macOS app launches from the installed bundle
- Debug/release APK path is reported and installed for validation

A live GitHub fork/clone/PR acceptance test uses a disposable repository only after explicit approval for that external mutation.

## Retention

- Active/recoverable manifests live as long as their sessions or owned worktrees.
- Completed manifests retain their safe audit summary for 30 days, after which cleanup may remove them if no owned resources remain.
- Each job keeps a bounded ring of 256 progress events; full subprocess output is never persisted by default.
- Safe cached mobile repository metadata expires after 30 days without reconnect and is deleted when the pairing is revoked.
- Diagnostic snippets are capped at 1 MiB per job, redacted before persistence, and removed with the completed manifest.

## Non-Goals

- Cloud execution or hosted T4 sessions
- Public relays or blind coordination servers
- Sending GitHub or SSH credentials to mobile
- Arbitrary mobile filesystem browsing
- GitLab or generic remote acquisition in the first version
- Automatic merge, remote-branch deletion, or destructive cleanup
- Copying dirty base-checkout changes into a session implicitly
- Replacing OMP's session/transcript authority with a separate T4 runtime
