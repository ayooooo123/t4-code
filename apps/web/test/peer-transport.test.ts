import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { encodePeerInvite, encodePeerWireFrame } from "@t4-code/protocol";

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
