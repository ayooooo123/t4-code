import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { encodePeerInvite, encodePeerWireFrame } from "@t4-code/protocol";

import { parsePeerBackend } from "../src/platform/mobile-connection-records.ts";
import { MOBILE_PEER_BACKEND_STORAGE_KEY } from "../src/platform/native-mobile.ts";
import { CapacitorPeerTransport } from "../src/platform/peer-transport.ts";

const INVITE = encodePeerInvite({
  desktopPublicKey: new Uint8Array(32).fill(1),
  capability: new Uint8Array(32).fill(2),
});

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/gu, "");
}

class MemoryStorage {
  readonly values = new Map<string, string>();
  getItem(key: string): string | null { return this.values.get(key) ?? null; }
  setItem(key: string, value: string): void { this.values.set(key, value); }
  removeItem(key: string): void { this.values.delete(key); }
}

afterEach(() => {
  vi.useRealTimers();
  delete (globalThis as { Capacitor?: unknown }).Capacitor;
  delete (globalThis as { window?: unknown }).window;
});

describe("CapacitorPeerTransport", () => {
  it("bounds a native connection attempt that never resolves", async () => {
    vi.useFakeTimers();
    const cancelOpen = vi.fn(() => Promise.resolve());
    Object.assign(globalThis, { window: globalThis });
    Object.defineProperty(globalThis, "Capacitor", {
      configurable: true,
      value: {
        Plugins: {
          T4PeerConnection: {
            addListener: () => Promise.resolve({ remove: () => undefined }),
            cancelOpen,
            close: () => Promise.resolve(),
            open: () => new Promise(() => undefined),
            write: () => Promise.resolve(),
          },
        },
      },
    });
    const transport = new CapacitorPeerTransport(INVITE);
    let settled = false;
    void transport.open().then(() => { settled = true; }, () => { settled = true; });

    await vi.advanceTimersByTimeAsync(50_000);

    expect(settled).toBe(true);
    expect(cancelOpen).toHaveBeenCalledTimes(1);
  });

  it("clears a stale saved peer invite when authorization is rejected", async () => {
    const storage = new MemoryStorage();
    storage.setItem(MOBILE_PEER_BACKEND_STORAGE_KEY, JSON.stringify(parsePeerBackend(INVITE)));
    const reload = vi.fn();
    const peerDataListeners = new Set<(event: { sessionId: string; data?: string }) => void>();
    const peerClosedListeners = new Set<(event: { sessionId: string }) => void>();
    const challenge = base64Url(encodePeerWireFrame({ type: "challenge", nonce: "desktop-nonce" }));
    const rejected = base64Url(encodePeerWireFrame({ type: "close", code: 4001, reason: "pairing rejected" }));
    let writes = 0;
    const nativeWrite = vi.fn(async () => {
      writes += 1;
      if (writes === 1) queueMicrotask(() => {
        for (const listener of peerDataListeners) listener({ sessionId: "session-1", data: challenge });
      });
      if (writes === 2) queueMicrotask(() => {
        for (const listener of peerDataListeners) listener({ sessionId: "session-1", data: rejected });
        for (const listener of peerClosedListeners) listener({ sessionId: "session-1" });
      });
    });
    Object.assign(globalThis, {
      window: {
        Capacitor: {
          Plugins: {
            T4PeerConnection: {
              addListener: (
                eventName: string,
                listener: (event: { sessionId: string; data?: string }) => void,
              ) => {
                if (eventName === "peerData") peerDataListeners.add(listener);
                if (eventName === "peerClosed") peerClosedListeners.add(listener as (event: { sessionId: string }) => void);
                return Promise.resolve({ remove: () => undefined });
              },
              cancelOpen: () => Promise.resolve(),
              close: () => Promise.resolve(),
              open: () => Promise.resolve({ sessionId: "session-1" }),
              write: nativeWrite,
            },
          },
        },
        localStorage: storage,
        location: { reload },
      },
    });
    const transport = new CapacitorPeerTransport(INVITE);

    await expect(transport.open()).rejects.toThrow("private mobile pairing was rejected");

    expect(storage.getItem(MOBILE_PEER_BACKEND_STORAGE_KEY)).toBeNull();
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("keeps a saved peer invite when an accepted proof closes before authorization", async () => {
    const storage = new MemoryStorage();
    const saved = JSON.stringify(parsePeerBackend(INVITE));
    storage.setItem(MOBILE_PEER_BACKEND_STORAGE_KEY, saved);
    const reload = vi.fn();
    const peerDataListeners = new Set<(event: { sessionId: string; data?: string }) => void>();
    const peerClosedListeners = new Set<(event: { sessionId: string }) => void>();
    const challenge = base64Url(encodePeerWireFrame({ type: "challenge", nonce: "desktop-nonce" }));
    let writes = 0;
    const nativeWrite = vi.fn(async () => {
      writes += 1;
      if (writes === 1) queueMicrotask(() => {
        for (const listener of peerDataListeners) listener({ sessionId: "session-1", data: challenge });
      });
      if (writes === 2) queueMicrotask(() => {
        for (const listener of peerClosedListeners) listener({ sessionId: "session-1" });
      });
    });
    Object.assign(globalThis, {
      window: {
        Capacitor: {
          Plugins: {
            T4PeerConnection: {
              addListener: (
                eventName: string,
                listener: (event: { sessionId: string; data?: string }) => void,
              ) => {
                if (eventName === "peerData") peerDataListeners.add(listener);
                if (eventName === "peerClosed") peerClosedListeners.add(listener as (event: { sessionId: string }) => void);
                return Promise.resolve({ remove: () => undefined });
              },
              cancelOpen: () => Promise.resolve(),
              close: () => Promise.resolve(),
              open: () => Promise.resolve({ sessionId: "session-1" }),
              write: nativeWrite,
            },
          },
        },
        localStorage: storage,
        location: { reload },
      },
    });
    const transport = new CapacitorPeerTransport(INVITE);

    await expect(transport.open()).rejects.toThrow("private mobile connection closed before it was ready");

    expect(storage.getItem(MOBILE_PEER_BACKEND_STORAGE_KEY)).toBe(saved);
    expect(reload).not.toHaveBeenCalled();
  });

  it("waits for native close completion before opening a replacement", async () => {
    let nextSession = 0;
    let resolveFirstClose: (() => void) | undefined;
    const peerDataListeners = new Set<(event: { sessionId: string; data?: string }) => void>();
    const nativeOpen = vi.fn(async () => ({ sessionId: `session-${++nextSession}` }));
    const nativeWrite = vi.fn(() => Promise.resolve());
    const nativeClose = vi.fn(() => {
      if (resolveFirstClose !== undefined) return Promise.resolve();
      return new Promise<void>((resolve) => {
        resolveFirstClose = resolve;
      });
    });
    Object.assign(globalThis, { window: globalThis });
    Object.defineProperty(globalThis, "Capacitor", {
      configurable: true,
      value: {
        Plugins: {
          T4PeerConnection: {
            addListener: (
              eventName: string,
              listener: (event: { sessionId: string; data?: string }) => void,
            ) => {
              if (eventName === "peerData") peerDataListeners.add(listener);
              return Promise.resolve({ remove: () => peerDataListeners.delete(listener) });
            },
            cancelOpen: () => Promise.resolve(),
            close: nativeClose,
            open: nativeOpen,
            write: nativeWrite,
          },
        },
      },
    });
    const authorized = base64Url(encodePeerWireFrame({ type: "authorized" }));
    const emitAuthorized = (sessionId: string): void => {
      for (const listener of peerDataListeners) listener({ sessionId, data: authorized });
    };

    const first = new CapacitorPeerTransport(INVITE);
    const firstOpening = first.open();
    await vi.waitFor(() => expect(nativeWrite).toHaveBeenCalledTimes(1));
    emitAuthorized("session-1");
    await firstOpening;
    first.close();

    const second = new CapacitorPeerTransport(INVITE);
    const secondOpening = second.open();
    await Promise.resolve();
    await Promise.resolve();
    const opensBeforeCloseCompleted = nativeOpen.mock.calls.length;
    resolveFirstClose?.();
    await vi.waitFor(() => expect(nativeWrite).toHaveBeenCalledTimes(2));
    emitAuthorized("session-2");
    await secondOpening;
    second.close();

    expect(opensBeforeCloseCompleted).toBe(1);
  });
});
