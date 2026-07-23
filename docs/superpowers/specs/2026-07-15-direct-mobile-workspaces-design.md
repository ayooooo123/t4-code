# Direct Mobile Pairing and Workspaces Design

## Goal

Make the direct HyperDHT connection approachable on desktop and Android, and
let either paired client choose an approved workspace root and create project
folders beneath it before starting OMP sessions.

The feature remains direct peer-to-peer. It must not introduce a relay,
T4-operated endpoint, or any other hosted service.

## Current constraints

- The desktop `PeerShareHost` authenticates a phone with the pairing
  capability and then proxies OMP frames over the direct HyperDHT stream.
- The Android connection screen already accepts a `t4peer://` invite and has
  a paste fallback. The QR scanner must be available without Google Play
  Services.
- OMP currently starts sessions for a supplied project; it does not own an
  app-level list of approved folders or create project folders for T4.
- The desktop, not Android, has access to the host filesystem. Every
  filesystem decision must therefore be made and validated on desktop.

## Pairing UX

### Desktop

The existing share action becomes the clear **Connect phone** entry point. Its
dialog has three explicit states:

1. Preparing the direct key.
2. Ready: QR, copyable key, persistent-pairing explanation, and connected
   device count.
3. Error: the failed step and a retry action.

Reset pairing requires confirmation because it disconnects paired phones.
Stopping the direct listener is separate from resetting the capability.

### Android

The connection screen presents direct pairing first:

1. **Scan desktop QR** is the primary action when the native scanner is
   available; it requests `CAMERA` only after the user presses it.
2. **Paste connection key** is always available.
3. Scanner-unavailable and camera-denied states explain the reason and keep
   paste available.

The Android integration must explicitly verify that the barcode plugin is
registered in the built Capacitor bridge. It may use on-device ML Kit, but
must not require Google Play Services.

## Approved workspace roots

The desktop persists an ordered list of approved absolute directories and one
active root. Desktop users can add roots with the native folder picker.

Paired mobile users can select the active root only from this approved list;
they cannot submit arbitrary host paths or browse the host filesystem. A
mobile root change is an authenticated request sent through the existing
direct peer connection and applied by the desktop.

The host checks each configured root with realpath/lstat before persisting it.
It rejects missing roots, files, symlink escapes, and paths outside an
approved root for all later project operations. Changing roots never moves or
deletes existing folders.

## Project-folder flow

Both desktop and mobile expose **New project** from the workspace/project rail.
The dialog collects a folder name and optional first-session title.

The desktop validates the name as one safe relative path segment, resolves it
under the active root, creates it atomically, and returns a project descriptor
containing only a stable ID and display-safe relative name. A new session is
then created for that project through the normal OMP path.

Groups in the rail remain projections of projects/sessions. A new empty
project appears immediately after folder creation, rather than waiting for a
session to exist.

## Direct peer protocol

The P2P wire gains a small, versioned workspace-admin request/response
envelope in addition to proxied OMP frames:

- `workspace.roots.list`
- `workspace.root.select`
- `workspace.project.create`

Only an already-authorized pairing stream may use these messages. Requests are
strictly schema-validated, serialized with the existing peer queue, and never
execute arbitrary commands. Filesystem work happens inside the desktop
process; mobile receives only safe root labels and project metadata.

Desktop-local UI uses the same host service rather than a duplicate code path.
That keeps authorization, validation, and resulting workspace state identical
for both clients.

## Error handling

- Camera unavailable/denied: paste flow remains usable.
- Direct connection failure: display an actionable direct-connection error;
  never offer a server or relay fallback.
- No roots configured: prompt to add one on desktop; mobile shows the empty
  state and cannot create a project.
- Invalid, duplicate, or inaccessible root: reject without changing the
  active root.
- Invalid folder name, existing non-directory, or filesystem failure: retain
  dialog input and explain the failure.

## Tests

- Component tests cover pairing dialog states and scanner availability,
  permission denial, scanned-key parsing, and paste fallback.
- Desktop service tests cover root persistence, canonicalization, path escape
  rejection, root selection, and folder creation.
- Protocol tests cover workspace-admin encoding, authorization, malformed
  requests, and peer stream ordering.
- Web/mobile tests prove desktop and peer-backed clients use the same project
  creation flow.
- Android debug build plus a physical-device camera test verifies the scanner
  is registered and opens. The emulator is not accepted as proof of a direct
  UDP hole-punch.
