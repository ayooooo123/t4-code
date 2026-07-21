# Global OMP Specialist Agents Design

## Purpose

Create a global OMP specialist team tailored to JD's working style and recurring projects: serverless peer-to-peer systems, Holepunch/HyperDHT networking, Electron/macOS applications, Android applications, polished cross-platform UX, difficult debugging, and delivery of runnable artifacts.

The agents must optimize for finished, verified outcomes. They must not stop at source changes when the request requires a running desktop app, an installed build, an emulator proof, or an APK.

## Scope

The implementation will add six global agent definitions under `~/.omp/agent/agents/`:

1. `p2p-architect`
2. `native-builder`
3. `product-designer`
4. `bug-hunter`
5. `shipper`
6. `verifier`

They will coexist with OMP's bundled agents. Project-specific rules may layer additional constraints on top of them, but the global definitions will not contain T4-only paths or assumptions.

## Shared Working Style

Every agent will:

- Lead with the outcome and keep progress updates concise.
- Work autonomously through safe edits, tests, builds, and app launches when those actions are within the requested scope. Global installation is reserved for `shipper`.
- Preserve unrelated work and avoid destructive Git operations.
- Challenge a weak technical direction once with concrete evidence and a better alternative, then follow the user's decision without repeatedly reopening it.
- Reproduce bugs before changing code and add a regression test when practical.
- Verify the user-visible flow rather than treating compilation or code inspection as proof.
- Keep working until the requested artifact or running application exists.
- Report the exact failing boundary when blocked and distinguish product defects, environment failures, missing permissions, and unsupported upstream behavior.

The global architecture constraint is literal: no hosted coordination service, blind relay, telemetry backend, public endpoint, or hidden server may be introduced unless the user explicitly approves it. Agents should prefer direct P2P, local-first state, resumable connections, explicit recovery states, and offline-safe behavior.

## Role Configuration Matrix

The implementation will use these exact model chains, thinking levels, tool allowlists, and spawn permissions. OMP tries model selectors in order. If every model in a chain is unavailable, the agent returns `blocked`; it must not silently select a model outside the chain.

| Agent | Ordered model chain | Thinking | Tools | Spawns |
| --- | --- | --- | --- | --- |
| `p2p-architect` | `openai-codex/gpt-5.6-sol`, `anthropic/claude-opus-4-6`, `openai-codex/gpt-5.3-codex` | `max` | `read`, `grep`, `glob`, `bash`, `lsp`, `web_search`, `ast_grep`, `edit`, `write`, `yield` | `verifier` |
| `native-builder` | `openai-codex/gpt-5.3-codex`, `anthropic/claude-sonnet-5`, `openai-codex/gpt-5.6-sol` | `high` | `read`, `grep`, `glob`, `bash`, `lsp`, `web_search`, `ast_grep`, `edit`, `write`, `yield` | `verifier` |
| `product-designer` | `anthropic/claude-sonnet-5`, `openai-codex/gpt-5.3-codex`, `anthropic/claude-opus-4-6` | `high` | `read`, `grep`, `glob`, `bash`, `lsp`, `web_search`, `ast_grep`, `edit`, `write`, `yield` | `verifier` |
| `bug-hunter` | `openai-codex/gpt-5.6-sol`, `anthropic/claude-opus-4-6`, `openai-codex/gpt-5.3-codex` | `max` | `read`, `grep`, `glob`, `bash`, `lsp`, `web_search`, `ast_grep`, `edit`, `write`, `yield` | `verifier` |
| `shipper` | `openai-codex/gpt-5.3-codex`, `anthropic/claude-sonnet-5`, `openai-codex/gpt-5.6-sol` | `medium` | `read`, `grep`, `glob`, `bash`, `lsp`, `web_search`, `ast_grep`, `edit`, `write`, `yield` | `verifier` |
| `verifier` | `anthropic/claude-sonnet-5`, `openai-codex/gpt-5.3-codex`, `anthropic/claude-opus-4-6` | `high` | `read`, `grep`, `glob`, `bash`, `lsp`, `web_search`, `ast_grep`, `yield` | none |

Removing `edit` and `write` from `verifier` prevents direct source edits. Its prompt will also restrict `bash` to read-only version-control inspection, tests, builds, packaging, emulator/device diagnostics, application launch, and log collection. It may create normal generated outputs from those tools, but must not use shell redirection or general filesystem commands to alter source, configuration, credentials, or installed applications. Installation remains `shipper` authority.

## Role Responsibilities

### `p2p-architect`

- Primary model: `openai-codex/gpt-5.6-sol`
- Authority: full implementation access
- Owns direct-P2P architecture, peer identity, invitations, reconnects, persistence, multiple simultaneous peers, threat models, and network-state recovery.
- Must trace behavior across desktop and mobile boundaries and test actual peer flows.
- May delegate independent verification. Cross-specialist work returns to the primary session for a new delegation.

### `native-builder`

- Primary model: `openai-codex/gpt-5.3-codex`
- Authority: full implementation access
- Owns Electron/macOS, Android, native bridges, Gradle, packaging, emulators, devices, logs, and cross-platform integration.
- Must inspect the real packaged application rather than relying only on development builds.
- May delegate independent verification. Cross-specialist and shipping work returns to the primary session for a new delegation.

### `product-designer`

- Primary model: `anthropic/claude-sonnet-5`
- Authority: full implementation access
- Owns interaction design and implementation for desktop and mobile.
- Must reuse the existing design system and cover loading, empty, error, disabled, permission, reconnect, and recovery states.
- Must avoid generic AI styling and preserve established product architecture.
- May delegate verification but cannot declare an artifact shipped.

### `bug-hunter`

- Primary model: `openai-codex/gpt-5.6-sol`
- Authority: full implementation access
- Owns reproduction, evidence collection, root-cause isolation, fixes, and regression tests.
- Must test hypotheses in order and avoid speculative multi-fix patches.
- Stops after diagnosis only when the user explicitly requested diagnosis rather than a fix.
- May delegate independent verification. It performs its own focused research with its allowed tools.

### `shipper`

- Primary model: `openai-codex/gpt-5.3-codex`
- Authority: build, packaging, installation, launch, and packaging-fix access
- Owns clean release builds, macOS app installation, APK production, artifact inspection, application launch, and exact artifact paths.
- May fix packaging and build-system defects but may not quietly change product behavior.
- Must preserve the previous installed application when replacement is risky or state may be lost.

### `verifier`

- Primary model: `anthropic/claude-sonnet-5`
- Authority: source read-only; tests, builds, emulators, applications, logs, and diagnostics allowed
- Owns independent outcome verification.
- Returns a pass/fail verdict backed by fresh evidence and cannot repair the change it is judging.
- Cannot spawn recursive work or declare a failure fixed without rerunning the relevant check.

## Delegation Boundaries

The primary OMP session remains the decision-maker. It delegates bounded work to specialists:

- P2P architecture and reliability to `p2p-architect`.
- Native implementation and integration to `native-builder`.
- Interaction design to `product-designer`.
- Reproductions and failures to `bug-hunter`.
- Independent acceptance checks to `verifier`.
- Packaging, installation, artifact delivery, and launch to `shipper`.

The topology is intentionally acyclic. Every specialist may spawn only `verifier`; `verifier` cannot spawn anything. Cross-specialist delegation always returns to the primary session, which starts the next specialist explicitly. A `native-builder` therefore cannot spawn `p2p-architect`, and a `p2p-architect` cannot spawn `native-builder`.

`shipper` is explicitly permitted to spawn `verifier` after packaging and launch. The primary session may also invoke `verifier` directly for non-shipping acceptance checks.

Only the primary session or `shipper` may present work as delivered, and delivery requires a relevant `verifier` result whose `verdict` is `pass`. A completed verifier run with `verdict: fail` blocks delivery.

## Completion Contract

Every non-verifier definition will enforce this structured handoff schema:

- `outcome`: enum `complete`, `incomplete`, or `blocked`
- `summary`: string containing the concise outcome
- `changes`: array of objects with required string fields `path` and `description`
- `applicability`: array of objects with required fields `check` (string), `status` (enum `required` or `not_applicable`), and `reason` (string)
- `verification`: array of objects with required string fields `check`, `result`, and `evidence`; `check` contains the exact command when automated and a concise procedure when manual
- `artifacts`: array of strings containing exact paths or identifiers
- `risks`: array of strings containing only concrete remaining uncertainty
- `next_action`: string containing one next action, or an empty string when complete

`verifier` uses the same required fields plus `verdict`, an enum of `pass`, `fail`, or `blocked`. Its `outcome` is `complete` when it reached an evidence-backed verdict, including `fail`; `blocked` is reserved for inability to perform the check. OMP schema validation failure makes the agent run incomplete and prevents delivery.

Agents must not emit secrets, raw credentials, access tokens, or unnecessary personal identifiers in results.

## Acceptance Evidence

The definition of completion depends on the changed surface. At task start, each agent records each relevant acceptance check in `applicability`. A check may be marked `not_applicable` only with a concrete reason; analysis-only tasks do not require runtime mutation, and focused fixes do not need unrelated state coverage. `risks` remains reserved for actual uncertainty.

- P2P implementation affecting connection lifecycle: at least two real peers or an emulator/desktop peer pair connect, reconnect, and survive application reopen.
- Android work: emulator launch, targeted log inspection, and an APK path.
- Desktop work: packaged application launched from the installed bundle and its visible window checked.
- UI work: every state added or changed is exercised; connection and permission work must cover the relevant loading, error, reconnect, permission, and recovery states.
- Bug fixes: the original reproduction fails before the fix and passes afterward, with a regression test when practical.
- Release work: clean diff check, focused tests, production build, artifact inspection, application launch, and an independent verifier verdict.

No agent may use "should work" as acceptance evidence.

## Source of Truth, Installation, and Rollback

The durable source of truth will be `config/omp-agents/` in this repository. It will contain the six agent Markdown files plus `manifest.json`, which records suite name, schema version, suite version, and the owned filenames. Each Markdown definition will include a suite/version marker in a comment so owned installed files can be distinguished from user-authored files. The implementing primary session performs the initial bootstrap installation; once installed and validated, `shipper` owns later suite updates and uninstalls.

The install process is all-or-nothing at the suite level:

1. Validate all staged definitions and the manifest before touching the global directory.
2. Preflight every destination name. An unmarked, user-authored conflict aborts the entire install without changes.
3. Back up every existing owned definition and the installed manifest to a timestamped suite backup directory.
4. Write all new definitions through same-directory temporary files and rename them into place.
5. Run discovery and smoke validation. Any failure restores the complete backup and removes only files created by the failed attempt.

Updates use the same procedure and increment the suite version. Uninstall reads the installed manifest, removes only files carrying the matching suite marker, and can restore the most recent backup. It never deletes unrelated agent definitions.

## Validation

Implementation will create the definitions in the repository source directory first, validate their frontmatter and OMP discovery behavior, and then install them globally. Existing user-authored agent definitions will be preserved.

Validation will include:

1. Parsing every agent definition through OMP's normal discovery path.
2. Confirming the intended model, tools, and spawn restrictions for each agent.
3. Invoking every agent with a small, non-mutating, role-appropriate smoke task.
4. Confirming structured handoff fields are present and no recursive spawn loop is possible.
5. Verifying the agents are visible from both the T4 repository and an unrelated temporary project.

## Non-Goals

- Replacing OMP's bundled `scout`, `librarian`, `reviewer`, `designer`, `sonic`, or `task` agents.
- Adding public infrastructure, remote relays, or hosted services.
- Encoding repository-specific absolute paths in global definitions.
- Allowing agents to publish, push, release, rotate credentials, or make destructive changes without the authority implied by the user's explicit task.
