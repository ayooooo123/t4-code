// Saved-host manager QOL guarantees: entering the manager mutates nothing,
// switching only re-points the active host, and a reload happens only after a
// successful switch or removal. The shared address form is side-effect free
// until its parse-and-probe submission succeeds.
import { renderToStaticMarkup } from "react-dom/server";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  MobileConnectionAction,
  performHostRemoval,
  performHostSwitch,
} from "../src/components/MobileConnectionAction.tsx";
import {
  probeAndSaveMobileBackend,
  safeTailnetFormMessage,
  TailnetAddressForm,
} from "../src/components/MobileConnectionScreen.tsx";
import {
  MOBILE_BACKEND_STORAGE_KEY,
  MOBILE_HOST_DIRECTORY_STORAGE_KEY,
  parseTailnetBackend,
  writeFirstRunTailnetBackend,
} from "../src/platform/native-mobile.ts";

const originalWindow = globalThis.window;
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let renderer: ReactTestRenderer | undefined;
let consoleError: ReturnType<typeof vi.spyOn> | undefined;

class MemoryStorage {
  readonly values = new Map<string, string>();
  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
  removeItem(key: string): void {
    this.values.delete(key);
  }
}

afterEach(async () => {
  await act(async () => { renderer?.unmount(); });
  renderer = undefined;
  consoleError?.mockRestore();
  consoleError = undefined;
  Object.defineProperty(globalThis, "window", { configurable: true, value: originalWindow });
});

describe("mobile saved-host manager", () => {
  it("renders the T4 hosts entry point without touching saved-host state", () => {
    const storage = new MemoryStorage();
    const bunker = parseTailnetBackend("https://bunker.tailnet.ts.net:8445");
    const laptop = parseTailnetBackend("https://laptop.tailnet.ts.net:8445");
    const seeded = JSON.stringify({
      version: 2,
      activeOrigin: bunker.origin,
      backends: [bunker, laptop],
    });
    storage.setItem(MOBILE_BACKEND_STORAGE_KEY, seeded);
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        Capacitor: { getPlatform: () => "android", isNativePlatform: () => true },
        localStorage: storage,
      },
    });

    const markup = renderToStaticMarkup(<MobileConnectionAction />);

    expect(markup).toContain('aria-label="T4 hosts"');
    expect(storage.getItem(MOBILE_BACKEND_STORAGE_KEY)).toBe(seeded);
    expect([...storage.values.keys()]).toEqual([MOBILE_BACKEND_STORAGE_KEY]);
  });

  it("switches hosts without any removal and reloads only after the selection persists", () => {
    const calls: string[] = [];
    const failure = performHostSwitch("https://laptop.tailnet.ts.net:8445", {
      reload: () => calls.push("reload"),
      select: (origin) => calls.push(`select:${origin}`),
    });
    expect(failure).toBeNull();
    expect(calls).toEqual(["select:https://laptop.tailnet.ts.net:8445", "reload"]);

    const failedCalls: string[] = [];
    const message = performHostSwitch("https://gone.tailnet.ts.net:8445", {
      reload: () => failedCalls.push("reload"),
      select: () => {
        throw new Error("That saved host is no longer available.");
      },
    });
    expect(message).toBe("That saved host is no longer available.");
    expect(failedCalls).toEqual([]);
  });

  it("reloads after a successful removal and keeps state when removal fails", async () => {
    const calls: string[] = [];
    const failure = await performHostRemoval("https://laptop.tailnet.ts.net:8445", {
      reload: () => calls.push("reload"),
      remove: async (origin) => {
        calls.push(`remove:${origin}`);
      },
    });
    expect(failure).toBeNull();
    expect(calls).toEqual(["remove:https://laptop.tailnet.ts.net:8445", "reload"]);

    const failedCalls: string[] = [];
    const message = await performHostRemoval("https://laptop.tailnet.ts.net:8445", {
      reload: () => failedCalls.push("reload"),
      remove: async () => {
        throw new Error("Android secure storage is unavailable");
      },
    });
    expect(message).toBe("Android secure storage is unavailable");
    expect(failedCalls).toEqual([]);
  });

  it("drops a late successful probe after the Add view is cancelled", async () => {
    const backend = parseTailnetBackend("https://later.tailnet.ts.net:8445");
    const controller = new AbortController();
    const calls: string[] = [];
    let finishProbe: (() => void) | undefined;
    const pendingProbe = new Promise<void>((resolve) => {
      finishProbe = resolve;
    });

    const result = probeAndSaveMobileBackend(backend, {
      signal: controller.signal,
      probe: () => pendingProbe,
      save: (candidate) => { calls.push(`save:${candidate.origin}`); },
      reload: () => calls.push("reload"),
    });
    controller.abort();
    finishProbe?.();

    await expect(result).resolves.toBe("cancelled");
    expect(calls).toEqual([]);
  });

  it.each([
    "t4-code:mobile-backend:v1",
    MOBILE_BACKEND_STORAGE_KEY,
    MOBILE_HOST_DIRECTORY_STORAGE_KEY,
  ])("refuses first-run Tailnet save when %s appears during its probe", async (occupiedKey) => {
    const storage = new MemoryStorage();
    const backend = parseTailnetBackend("https://pending.tailnet.ts.net:8445");
    const controller = new AbortController();
    let finishProbe!: () => void;
    const pendingProbe = new Promise<void>((resolve) => { finishProbe = resolve; });
    const reloads: string[] = [];
    const result = probeAndSaveMobileBackend(backend, {
      signal: controller.signal,
      probe: () => pendingProbe,
      save: (candidate) => writeFirstRunTailnetBackend(candidate, storage),
      reload: () => reloads.push("reload"),
    });

    storage.setItem(occupiedKey, "exact bytes that appeared");
    finishProbe();
    await expect(result).resolves.toBe("refused");
    expect(storage.getItem(occupiedKey)).toBe("exact bytes that appeared");
    expect([...storage.values.keys()]).toEqual([occupiedKey]);
    expect(reloads).toEqual([]);
  });

  it("reuses one probing address form for startup and in-app add", () => {
    const saved: string[] = [];
    const markup = renderToStaticMarkup(
      <TailnetAddressForm save={(backend) => { saved.push(backend.origin); }} submitLabel="Check and add" />,
    );
    expect(markup).toContain("Tailnet address");
    expect(markup).toContain("Check and add");
    expect(markup).toContain("Use the full HTTPS address shown by the T4 gateway on your computer.");
    // Rendering the form saves nothing: persistence happens only after a
    // successful probe on submit.
    expect(saved).toEqual([]);
  });

  it("renders only typed Tailnet errors and never arbitrary runtime details", () => {
    let known: unknown;
    try { parseTailnetBackend("http://unsafe.example"); } catch (error) { known = error; }
    expect(safeTailnetFormMessage(known, "validation")).toContain("HTTPS");
    expect(safeTailnetFormMessage(new Error("secret runtime path /private/key"), "validation")).toBe(
      "Enter a valid HTTPS Tailnet address.",
    );
    expect(safeTailnetFormMessage(new Error("secret socket payload"), "probe")).toBe(
      "T4 Code could not verify that host. Check Tailscale and try again.",
    );
  });

  it("shows a controlled refusal and does not reload when first-run Tailnet state races", async () => {
    consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const reloads: string[] = [];
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: { location: { reload: () => reloads.push("reload") } },
    });
    await act(async () => {
      renderer = create(
        <TailnetAddressForm
          probe={() => Promise.resolve()}
          save={() => false}
          submitLabel="Use Tailscale address"
        />,
      );
    });
    await act(async () => {
      renderer!.root.findByType("input").props.onChange({ target: { value: "https://race.tailnet.ts.net:8445" } });
    });
    await act(async () => {
      renderer!.root.findByType("form").props.onSubmit({ preventDefault: () => undefined });
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(JSON.stringify(renderer!.toJSON())).toContain("Another saved connection appeared. Nothing was replaced");
    expect(reloads).toEqual([]);
  });
});
