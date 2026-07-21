# Extensible Remote Access and Reliable Mobile Pairing

## Purpose

Make remote access feel like one native T4 Code feature while preserving the
different security and networking properties of each transport. Tailscale
remains fully supported. HyperDHT becomes an additional serverless option, and
the architecture leaves a deliberate extension seam for transports such as
Iroh.

The same desktop may be reachable through more than one transport. Mobile must
keep all configured methods, reconnect reliably after relaunch, and never erase
a saved Tailscale host when the user scans a HyperDHT key.

## Product Principles

- The user selects a T4 host first and a connection method second.
- Tailscale and HyperDHT are first-class peers in the UI; neither is presented
  as a hidden fallback or temporary compatibility mode.
- T4 does not add a hosted coordinator, application relay, credential broker,
  or public blind-relay endpoint.
- Automatic fallback is allowed while opening and completing the OMP handshake,
  and after an idle disconnect, but not while an application command has an
  unsettled outcome.
- An uncertain command outcome remains pinned to the transport that sent it;
  T4 never replays the command through another transport.
- Pairing and transport controls stay visible but do not dominate normal
  session work after setup.

## Chosen Architecture

### Host directory

Mobile stores a versioned directory of logical T4 hosts. Each host has:

- An opaque stable host ID.
- A user-facing label.
- One or more transport configurations.
- A preferred, ordered list of transport IDs.
- Safe last-connection metadata such as transport kind, timestamp, and bounded
  failure category.

Transport records use a discriminated union. The first version contains:

- `tailscale`: HTTPS origin, WebSocket URL, display address, and the secure
  credential scope key.
- `hyperdht`: validated private invite, desktop public-key fingerprint, and no
  separately persisted derived secret.

The directory and selection APIs operate on host and transport IDs rather than
assuming that every host is a Tailnet origin. Adding Iroh requires a new union
member and adapter, not a second host-management system.

### Transport adapters

Every mobile connection adapter implements the same bounded lifecycle:

1. Validate its stored configuration.
2. Report availability on the current platform.
3. Open with an abort signal and a finite timeout.
4. Report safe progress and failure categories.
5. Return an OMP transport that can complete the protocol handshake before the
   application runtime accepts it.
6. Close or cancel cleanly, including native work that has not returned a
   session ID yet.

The connection coordinator tries the preferred transport first, then configured
fallbacks sequentially. Transport-level and OMP handshake/control frames do not
commit the route. The exact commit boundary is the successful call that writes
an application command frame to the active OMP transport. The OMP runtime owns
that boundary and gives the coordinator an opaque unsettled-operation ID. The
coordinator retains a set per transport and considers the route idle only when
that set is empty.

During startup, handshake failure may advance to the next transport. An idle
disconnect ends the connection epoch and may also use the configured fallback
order. Once an application command is sent, that operation remains pinned to
the sending transport until it receives a terminal result or same-transport
reconciliation establishes the outcome. If that route is unavailable, the UI
reports an unknown outcome and does not open another route for that operation.
After the outcome settles, a later idle connection epoch may choose another
transport. This pin is per unsettled application operation, not permanent for
the host or OMP session.

An explicit diagnostic connection to one method bypasses the fallback sequence.
It either connects through that transport or reports that transport's failure,
so diagnosis is never masked by a successful alternate route.

The adapters remain transport-specific internally:

- Tailscale uses the existing HTTPS probe, WebSocket connection, device
  enrollment, and native secure credential storage.
- HyperDHT uses the native peer plugin, attempt IDs, challenge/HMAC
  authorization, persistent desktop listener, and explicit cancellation that
  wakes and releases the native DHT loop.

### Desktop ownership

Desktop owns transport exposure and presents a unified Remote Access panel.
Each registered provider contributes status and actions without sharing secret
material with other providers.

The Tailscale card shows gateway status, address, copy action, and setup help.
The HyperDHT card shows listener status, a deliberately revealed pairing QR/key,
active connection count, and reset-pairing. Reset requires destructive
confirmation because it rotates the capability, disconnects active HyperDHT
streams, and invalidates every previously scanned invite. It does not alter
Tailscale configuration.

Future providers implement the same presentation contract: provider identity,
availability, safe status, setup actions, and optional pairing material.

## Persistence and Migration

The current mobile storage can contain either a Tailnet directory or a single
HyperDHT invite under the v2 key. The logical host directory uses a distinct v3
key. Startup performs an idempotent migration:

- A Tailnet directory becomes one logical host per saved origin, retaining the
  active host and every scoped native credential.
- A standalone HyperDHT invite becomes one logical host with one HyperDHT
  transport.
- If recoverable legacy and current records coexist, both are imported and
  deduplicated by canonical transport identity.
- Migration validates the complete candidate directory in memory, writes it to
  the distinct v3 key, reads and validates that exact v3 record, and only then
  removes the v2 and legacy keys. Failure removes an invalid v3 candidate, leaves
  every source key intact, and opens repair setup.
- If a valid v3 record already exists, startup uses it and removes no source
  record automatically. This makes retries and interrupted migrations safe.

Adding HyperDHT from an existing host's details explicitly appends the scanned
transport to that selected host. A first-run or top-level scan creates a new host
preview, because a Tailnet origin does not expose the HyperDHT desktop public key
and T4 cannot securely infer that they are the same machine. T4 never silently
merges hosts across transports. Removing one transport preserves the host and
its remaining methods. Removing the final method requires host-level
confirmation.

HyperDHT invites remain local application data and are bearer grants. They are
not included in diagnostics, safe status, connection errors, or peer frames.
Tailnet credentials remain in native secure storage and are keyed by their
existing canonical host scope.

## Mobile Setup and Host Management

### First run

The first-run screen asks the user to connect to a T4 host and offers explicit
methods:

- Scan HyperDHT QR code.
- Paste HyperDHT connection key.
- Enter Tailscale address.

Selecting a method opens a focused form rather than one input that guesses the
transport from its contents. Successful validation creates the host directory,
selects the host, and starts a connection. Failed or cancelled setup writes
nothing.

### Host manager

The host list shows one row per logical desktop with badges for configured
transports and a concise connection-health state. Host details allow the user
to:

- Add or remove a connection method.
- Select and reorder the preferred fallback sequence.
- Connect explicitly with one method for diagnosis.
- Rename the local display label.
- Remove the host after confirmation.

Connection progress names each attempted method, for example `Trying
Tailscale`, `Tailscale unavailable`, and `Trying HyperDHT`. An attempt always
settles into connected, actionable failure, or cancelled state; the UI cannot
remain indefinitely on `Connecting`.

## Reliable QR Scanning

QR scanning is an acceptance-critical native flow.

### Capability and permission handling

- The packaged Android barcode-scanner plugin is a required registered native
  capability. The scan action's availability derives from that specific plugin
  and its asynchronous support check, not from the general Capacitor bridge.
  Paste remains available when registration or hardware support is absent.
- Opening the scanner checks plugin registration, camera hardware support, and
  camera permission separately.
- A first use requests permission through the scanner plugin.
- Denied permission produces an actionable message with retry and Android app
  settings guidance. Permanent denial does not repeatedly prompt.
- GrapheneOS and devices without Google services use the packaged native camera
  scanner directly; the flow must not depend on Google Play Services or an
  external camera application.
- Android scanning uses a CameraX surface with a barcode decoder bundled inside
  the APK. It must not invoke the Google Play Services Code Scanner API or an
  unbundled model that downloads through Google Play Services.

### Scanner lifecycle

- The app presents a visible full-screen scanner surface with a framing guide,
  cancel control, permission/status copy, and preserved safe-area behavior.
- Only QR codes are requested from the native scanner.
- Listener registration completes before scanning starts.
- Every open creates a unique attempt token and a state machine with
  `checking`, `starting`, `scanning`, and one terminal state. The first valid
  terminal transition wins; late callbacks and results with an old token are
  ignored.
- Cleanup is idempotent and stops scanning, removes every listener exactly once,
  and invalidates the token. If `startScan` resolves after cleanup, its late
  completion immediately calls `stopScan` again and cannot restore scanning UI.
- The first non-empty scan result begins validation and cleanup immediately.
- Back navigation, cancel, app backgrounding, component unmount, permission
  failure, plugin error, and timeout all stop the camera and remove listeners.
- Reopening the scanner after any terminal path starts a fresh attempt without
  stale listeners or an `opening` guard.

### Validation and persistence

- Scanned text is bounded to 2,048 UTF-8 bytes before parsing. One scanner
  attempt times out after 60 seconds.
- Only a canonical `t4peer://v1/` invite with valid key and capability lengths
  is accepted.
- Invalid and unrelated QR codes close that native scan attempt, keep the
  scanner surface open with a bounded inline error and `Scan again`, and are
  never persisted. `Scan again` creates a fresh attempt token.
- A valid invite scanned from an existing host's details is proposed for that
  host after confirmation. A top-level scan deduplicates only against another
  HyperDHT transport with the same desktop public key; otherwise it previews a
  new host.
- The user confirms the host preview before persistence and connection.
- Paste uses the exact same parser, preview, deduplication, and persistence
  path as scanning.

## Connection Failure and Recovery

Failures are stable, bounded, and transport-aware. Scanner failures use the
stable categories `plugin_missing`, `camera_unsupported`, `permission_denied`,
`permission_blocked`, `scan_timeout`, `scan_cancelled`, `invalid_qr`, and
`scanner_error`; safe user copy is mapped from those categories.

- Transport unavailable on this platform.
- Camera unavailable or permission denied.
- Pairing key invalid or revoked.
- Tailscale unavailable or gateway unreachable.
- HyperDHT discovery or authorization timeout.
- Host reached but OMP unavailable.
- Connection lost before command send.
- Connection lost with command outcome unknown.

Only opening/handshake failures and idle disconnects permit automatic fallback.
Authentication rejection can advance to another independently configured
transport before an application command is sent, but is shown to the user
because it may indicate revoked pairing. Configuration and validation failures
do not loop. Backoff is bounded, cancellable, and reset by an explicit user retry
or network-state recovery. An operation-in-flight pins reconciliation to its
sending transport as defined above.

On app relaunch, mobile loads the selected host and tries its explicit configured
order. Automatically promoting the last successful transport is deferred.

Desktop continues accepting up to four concurrent authorized HyperDHT streams.
Each stream owns an independent OMP transport. Tailscale connections are not
counted against this HyperDHT limit.

## Security Boundaries

- Desktop HyperDHT secret key and capability are encrypted with Electron
  `safeStorage`.
- Mobile never exposes the full invite outside explicit pairing management.
- Safe logs may include transport kind and a short public-key fingerprint, but
  not invite, capability, device token, authorization proof, or credential
  helper output.
- QR previews identify the desktop by a bounded fingerprint and local label;
  they make no unauthenticated claim about a human identity.
- Fallback does not weaken transport-specific authentication. Each adapter must
  complete its own authorization before OMP data flows.
- No provider is permitted to introduce a hosted relay implicitly. A future
  provider that can use relays must expose that mode explicitly in its design
  and UI before inclusion.

## Testing and Acceptance

### Unit and component tests

- Migrate every supported legacy storage shape without losing Tailnet hosts or
  overwriting a HyperDHT invite.
- Exercise migration interruption before v3 write, after v3 write, after v3
  read-back validation, and between removal of individual source keys. A valid
  pre-existing v3 record is never overwritten.
- Reject corrupt migration input without destroying the source record.
- Add/remove/reorder transports while preserving host identity and credentials.
- Try preferred and fallback transports in order.
- Prove handshake frames do not commit a route, an application command does,
  and an idle connection epoch may later use another transport.
- Prove uncertain mutations are never replayed.
- Keep fallback blocked until every unsettled operation pinned to a disconnected
  transport settles, and prove a diagnostic connection never falls back.
- Settle timeout/cancel paths and remove listeners once.
- Render desktop provider cards and mobile method-specific setup/management.

### QR tests

- Plugin absent, camera unsupported, permission prompt, denial, permanent
  denial, grant, cancel, background, timeout, invalid QR, valid QR, duplicate
  host, and retry-after-failure.
- Assert listener-before-start ordering, attempt-token race handling, and
  idempotent stop/remove behavior for every terminal and late-completion path.
- Assert scanner can reopen after cancellation or plugin failure.
- Assert only confirmed, validated invites reach storage.
- Assert paste and scan produce the same host/transport record.
- Verify touch targets, safe areas, accessible labels, and visible error/status
  announcements.

### Integration gates

- Desktop, protocol, client, and web test suites.
- Full TypeScript typecheck.
- Android Kotlin/JNI compilation and debug APK assembly with Java 21.
- Android emulator install, permission grant/deny, scan-result injection or
  native test double, background/foreground, force-stop/relaunch, and repeated
  scanner-open smoke test.
- Inspect the packaged APK dependency/runtime path to prove scanning uses the
  CameraX plus bundled-decoder implementation and does not require Google Play
  Services Code Scanner or an unbundled model download.
- Desktop listener restart, two transport configurations for one host, forced
  preferred-transport failure, successful fallback, and session reconciliation.
- Physical GrapheneOS verification remains the final camera and UDP
  hole-punch acceptance gate.

## Delivery Order

1. Introduce and migrate the logical host/transport directory.
2. Add the transport adapter/coordinator contract with safe fallback.
3. Rebuild mobile first-run and host-management flows.
4. Harden and verify the native QR scanner lifecycle.
5. Consolidate desktop Remote Access provider cards.
6. Run emulator, packaged desktop, and physical-device acceptance.
