import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { encodePeerInvite } from "@t4-code/protocol";

import { CapacitorPeerTransport } from "../src/platform/peer-transport.ts";

const INVITE = encodePeerInvite({
  desktopPublicKey: new Uint8Array(32).fill(1),
  capability: new Uint8Array(32).fill(2),
});

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
});
