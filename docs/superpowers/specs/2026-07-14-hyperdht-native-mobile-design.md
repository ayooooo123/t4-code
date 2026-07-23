# Native HyperDHT Mobile Connection Design

## Goal

Add a peer-to-peer alternative to Tailnet remote access. A person running T4
Code on desktop can create a time-limited phone connection, see a T4 peer key
as text or a QR code, and use the bundled Android app to paste or scan that key
and connect to the same OMP appserver.

## Chosen approach

Use the official JavaScript `hyperdht` package in the desktop process and the
wire-compatible `jjacke13/hyperdht-cpp` library in Android. The Android app
loads the library as a dynamically linked `libhyperdht.so` through a Kotlin/JNI
Capacitor plugin. This avoids an external VPN account, a public port, a local
HTTP proxy, and the GPL/AGPL dependencies in Holesail.

The desktop and Android implementations exchange bytes over HyperDHT's
Noise-encrypted stream. The Android WebView never opens a cleartext local
socket; a Capacitor bridge carries the framed messages between the WebView and
the native peer connection.

## User flow

1. In desktop T4 Code, the user selects **Connect phone**.
2. Desktop creates a fresh, in-memory HyperDHT key pair and a random
   32-byte capability secret, starts listening, and displays the invite as a
   copyable text key and QR code.
3. In Android T4 Code, the user selects **Connect via peer key**, then pastes
   the text or scans the QR code.
4. Android validates the versioned invite, starts its native HyperDHT client,
   and connects to the desktop public key.
5. The peers perform a capability challenge before any OMP traffic is accepted.
   On success, Android opens the existing remote T4 session through the P2P
   transport. The UI reports connecting, connected, disconnected, or an
   actionable error.
6. Desktop can stop the share or generate a new key. Either action immediately
   invalidates the previous invite and terminates its active connection.

Tailnet profiles remain available and unchanged.

## Invite format and authorization

The QR code and copied text contain the same `t4peer://v1/...` payload:

```text
t4peer://v1/<base64url-desktop-public-key>/<base64url-capability-secret>
```

The public key is routing information. The capability secret is the access
grant and must never be logged, stored in desktop settings, included in crash
reports, or printed by diagnostics. It is held only in memory on desktop. The
mobile app does not persist peer profiles or pasted invites in the first
release.

Immediately after stream open, Android sends a protocol version and a keyed
challenge response derived from the capability secret. Desktop closes the
stream without forwarding any application bytes when validation fails, when the
share is stopped, or when the one-phone limit is already in use.

The capability is bearer access: anyone who possesses a live QR/key can
connect. The desktop UI must communicate this and expose stop/regenerate.

## Architecture

```text
Desktop T4 Electron main process
  HyperDHT JavaScript server
    encrypted duplex stream
      T4 peer protocol bridge
        existing OMP appserver client

Android Capacitor app
  Web UI -> Capacitor P2P plugin -> Kotlin/JNI -> libhyperdht.so
                                                  encrypted duplex stream
```

### Desktop peer host

`packages/remote` owns a transport-neutral remote-session interface. A new
desktop-only peer host adapts an accepted HyperDHT stream to that interface and
to the existing OMP appserver client. The host permits one connected Android
device per live share and owns lifecycle, expiry, errors, and revocation.

The Electron IPC surface exposes start, stop, status, and subscribe operations.
Only safe share metadata (state, expiry, and public invite string when
explicitly requested) reaches the renderer. Secrets never enter persistent
desktop storage.

### Android native transport

The Capacitor plugin owns native networking and exposes a minimal, typed API:

- `connect(invite)` starts/reuses the DHT node and resolves only after the
  authorization handshake succeeds.
- `send(frame)` writes a bounded application frame.
- `disconnect()` closes the active stream.
- status and received-frame events are delivered to the web layer.

The plugin uses `hyperdht-cpp` as an unmodified shared library. Gradle builds
the Android ABIs required by the existing APK. JNI is kept narrow: Kotlin owns
plugin lifecycle and converts byte arrays, while C++ owns DHT callbacks and the
event loop. Native code must apply message-size limits, cancellation, and
backpressure before handing frames to Java/Kotlin.

### Web transport adapter

The existing remote client gains a transport interface with the current WSS
implementation and a new Capacitor-peer implementation. The peer implementation
uses the plugin frame API rather than `WebSocket`, so Android's `https` WebView
configuration and `allowMixedContent: false` stay intact.

## Reliability and privacy

- Sharing expires after 15 minutes unless the user renews it; stopping or
  regenerating ends it immediately.
- The mobile app reconnects only while its connection screen is visible and
  never silently persists a pasted invite.
- Connection diagnostics contain state and error categories, never the invite
  or capability secret.
- A direct path is preferred; HyperDHT's relay fallback may be used when the
  underlying library selects it. Failure on restrictive networks is shown as a
  connection error, not as a false connected state.
- The desktop appserver remains the authority for all sessions and commands.

## Dependency and licensing boundary

Desktop adds the official MIT-licensed JavaScript `hyperdht` dependency.
Android vendors or builds a pinned `hyperdht-cpp` release as a dynamically
linked LGPL-3.0 shared library. T4 retains its MIT license; release packaging
must include the library's license, notices, and the relinking/source materials
required by LGPL-3.0. This is an engineering packaging requirement, not legal
advice.

The upstream C++ project is independent rather than an official Holepunch
repository. Pin its source revision, record its checksum/provenance, and run
interoperability tests against the pinned JavaScript `hyperdht` version.

## Testing and acceptance criteria

Unit tests must cover invite encoding/decoding, invalid inputs, secret redaction,
handshake success/failure, single-device admission, expiry, and revocation.
Desktop tests must verify that stopped/regenerated shares reject old invites and
that no event payload contains a secret.

Android JVM tests must cover Kotlin invite validation and plugin state mapping.
Native tests must exercise the JNI byte boundary and resource cleanup. An
integration test runs a JavaScript HyperDHT desktop host against the Android
native library on a loopback or controlled network. A physical-device test
must cover QR scan, paste, direct connection or relay fallback, session list,
and one real OMP command round-trip.

Release acceptance requires the desktop app to build, the Android debug APK to
build, and the existing Tailnet path to remain covered by its current tests.

## Out of scope for the first release

- iOS support
- multiple phones per share
- persistent peer-key profiles
- a public relay service operated by T4
- file transfer or general TCP tunnelling
- replacing Tailnet
