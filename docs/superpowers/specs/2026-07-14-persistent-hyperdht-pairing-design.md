# Persistent HyperDHT Pairing Design

## Goal

Make an Android device that has explicitly scanned a desktop T4 Code QR key
reconnect after either app is reopened, while allowing several paired phones to
use the desktop concurrently. Tailnet remains an independent connection route.

## Problem

The initial peer implementation creates a random desktop DHT identity and
capability for each share, then discards both after 15 minutes. Android saves
the resulting `t4peer://` value, but that value carries no expiry metadata and
therefore becomes an indistinguishable stale pairing. A timed-out native open
also has no session identifier, so the web layer cannot cancel the native DHT
attempt it started.

## Chosen design

Desktop owns one long-lived HyperDHT key pair and one long-lived bearer pairing
capability. They are encrypted with Electron `safeStorage` before being written
to the desktop profile. The peer host listens with that identity for the life
of the desktop process. Opening the desktop share UI exposes the same QR/key;
scanning it is an explicit pairing action. Any number of already-paired phones
may open independent OMP transports at the same time.

**Reset pairing** creates a new capability, persists it before exposing the
replacement QR/key, and closes every active peer stream. This immediately
revokes every previously scanned key. The desktop DHT identity remains stable,
so resetting has an explicit, understandable security effect: it revokes
authorization rather than changing the host address.

The implementation caps concurrent authorized streams at four. This prevents a
leaked bearer key from consuming unbounded local OMP resources while still
supporting a person’s phones/tablets. Rejected excess streams receive no OMP
traffic and are closed.

## Connection lifecycle

1. Desktop starts its persistent DHT listener during lifecycle startup.
2. Android reads the locally stored peer invite and opens a native DHT attempt.
3. The attempt has a generated identifier before it reaches native code.
4. On stream open, the existing challenge/HMAC authorization completes before
   any OMP bytes are forwarded.
5. A temporary network loss or app suspension ends that stream. The mobile
   transport reports the failure and makes a bounded, cancellable reconnect
   attempt rather than leaving the UI indefinitely in `Connecting`.
6. When the web timeout or user disconnect fires before a native session is
   created, it calls `cancelOpen(attemptId)`. Native cancels the coroutine and
   wakes/closes the DHT event loop, releasing the `opening` guard.

The Android wrapper’s close path must wake the native libuv loop before waiting
for it to finish. Otherwise a cancelled lookup can leave the loop blocked and
the next pairing attempt appears to hang.

## Privacy and security

- The DHT secret key and capability remain encrypted at rest on desktop and
  never appear in peer status, logs, diagnostics, or error text.
- The Android invite remains local application data; it is a bearer grant and
  must not be displayed outside explicit connection setup.
- A desktop without usable Electron encrypted storage does not enable
  persistent peer sharing.
- A QR/key reset revokes all paired devices. Per-device revocation is deferred;
  the current protocol does not assign an independently persisted mobile
  identity.

## Tests and acceptance criteria

- The desktop host accepts four independent authorized streams and rejects a
  fifth without opening an OMP transport.
- Restarting a host with the same restored key pair and capability retains the
  advertised desktop public key and authorizes an existing invite.
- Resetting capability rejects old invites, closes all active streams, and
  authorizes only the replacement key.
- A native open cancellation releases the opening guard and permits a new
  attempt. The JavaScript transport settles on timeout and calls native
  cancellation exactly once.
- Desktop and web suites, Android Kotlin compilation, APK assembly, and an
  emulator restart test pass. A physical Android connection/reopen test remains
  the final end-to-end validation because the emulator may not support the
  required UDP hole-punch route.
