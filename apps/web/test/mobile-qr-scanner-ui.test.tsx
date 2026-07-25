import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { StrictMode } from "react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { MobileQrScannerFlow } from "../src/components/MobileQrScannerFlow.tsx";
import { MobileConnectionScreen } from "../src/components/MobileConnectionScreen.tsx";
import { parseTailnetBackend } from "../src/platform/mobile-connection-records.ts";
import { MobileQrScanError, buildPeerPairingCandidate, type MobileQrScanAttempt } from "../src/platform/mobile-qr-scanner.ts";
import { MOBILE_BACKEND_STORAGE_KEY, writeFirstRunPeerBackend } from "../src/platform/native-mobile.ts";

const KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const INVITE = `t4peer://v1/${KEY}/${KEY}`;
const originalWindow = globalThis.window;
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function deferredAttempt({ closeOnCancel = true }: { readonly closeOnCancel?: boolean } = {}): {
  readonly attempt: MobileQrScanAttempt;
  open(): void;
  close(): void;
  resolve(): void;
  reject(error: MobileQrScanError): void;
  readonly cancels: string[];
} {
  let resolve!: (value: ReturnType<typeof buildPeerPairingCandidate>) => void;
  let reject!: (error: MobileQrScanError) => void;
  let open!: () => void;
  let close!: () => void;
  const cancels: string[] = [];
  return {
    attempt: {
      opened: new Promise((resolveOpened) => { open = resolveOpened; }),
      closed: new Promise((resolveClosed) => { close = resolveClosed; }),
      result: new Promise((accept, decline) => { resolve = accept; reject = decline; }),
      cancel: (reason) => {
        cancels.push(reason);
        reject(new MobileQrScanError("scan_cancelled", reason));
        if (closeOnCancel) close();
      },
    },
    open,
    close,
    resolve: () => resolve(buildPeerPairingCandidate(INVITE)),
    reject: (error) => { reject(error); close(); },
    cancels,
  };
}

function button(renderer: ReactTestRenderer, label: string) {
  return renderer.root.findAllByType("button").find((node) => node.children.join("").includes(label));
}

class MemoryStorage {
  readonly values = new Map<string, string>();
  getItem(key: string): string | null { return this.values.get(key) ?? null; }
  setItem(key: string, value: string): void { this.values.set(key, value); }
}

async function renderFlow(props: Partial<React.ComponentProps<typeof MobileQrScannerFlow>> = {}) {
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(
      <MobileQrScannerFlow
        checkCapability={() => Promise.resolve("supported")}
        createAttempt={() => deferredAttempt().attempt}
        onDismiss={() => undefined}
        save={() => true}
        {...props}
      />,
    );
  });
  return renderer;
}

let renderer: ReactTestRenderer | undefined;
let consoleError: ReturnType<typeof vi.spyOn> | undefined;
afterEach(() => {
  renderer?.unmount();
  renderer = undefined;
  consoleError?.mockRestore();
  consoleError = undefined;
  Object.defineProperty(globalThis, "window", { configurable: true, value: originalWindow });
});

describe("mobile QR scanner pairing flow", () => {
  it("exposes modal dialog semantics, initial focus, and Escape dismissal", async () => {
    consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const dismisses: string[] = [];
    renderer = await renderFlow({ onDismiss: () => dismisses.push("dismiss") });
    const dialog = renderer.root.findByProps({ role: "dialog" });
    expect(dialog.props["aria-modal"]).toBe("true");
    expect(dialog.props["aria-labelledby"]).toBe("mobile-pairing-title");
    expect(dialog.props["aria-describedby"]).toBe("mobile-pairing-status");
    expect(dialog.props.tabIndex).toBe(-1);
    await act(async () => { dialog.props.onKeyDown({ key: "Escape", stopPropagation: () => undefined }); });
    expect(dismisses).toEqual(["dismiss"]);
  });

  it("ignores an obsolete StrictMode capability result that resolves last", async () => {
    consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const resolvers: Array<(value: "supported" | "unavailable") => void> = [];
    const checkCapability = () => new Promise<"supported" | "unavailable">((resolve) => { resolvers.push(resolve); });
    await act(async () => {
      renderer = create(
        <StrictMode>
          <MobileQrScannerFlow checkCapability={checkCapability} createAttempt={() => deferredAttempt().attempt} onDismiss={() => undefined} save={() => true} />
        </StrictMode>,
      );
    });
    expect(resolvers).toHaveLength(2);
    await act(async () => { resolvers[1]?.("supported"); });
    expect(button(renderer!, "Scan QR code")).toBeDefined();
    await act(async () => { resolvers[0]?.("unavailable"); });
    expect(button(renderer!, "Scan QR code")).toBeDefined();
    expect(JSON.stringify(renderer!.toJSON())).not.toContain("Camera scanning isn’t available");
  });

  it("disables scan while capability loads and exposes accessible live status", async () => {
    consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    renderer = await renderFlow({ checkCapability: () => new Promise(() => undefined) });
    const scan = button(renderer, "Checking camera");
    expect(scan?.props.disabled).toBe(true);
    expect(scan?.props.className).toMatch(/h-12|min-h-\[44px\]/u);
    expect(renderer.root.findAllByType("p").find((node) => node.props.role === "status")?.props["aria-live"]).toBe("polite");
  });

  it("hides scanning when native hardware is unavailable and keeps paste guidance", async () => {
    consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    renderer = await renderFlow({ checkCapability: () => Promise.resolve("unavailable") });
    expect(button(renderer, "Scan QR code")).toBeUndefined();
    expect(renderer.toJSON()).toEqual(expect.objectContaining({ type: "section" }));
    expect(JSON.stringify(renderer.toJSON())).toContain("Paste private key");
    expect(JSON.stringify(renderer.toJSON())).toContain("Camera scanning isn’t available");
  });

  it("keeps opening until native start and keeps closing until native release", async () => {
    consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const scan = deferredAttempt({ closeOnCancel: false });
    renderer = await renderFlow({ createAttempt: () => scan.attempt });
    await act(async () => { button(renderer!, "Scan QR code")?.props.onClick(); });
    expect(JSON.stringify(renderer.toJSON())).toContain("Opening camera");
    expect(JSON.stringify(renderer.toJSON())).not.toContain("Scanner active");
    await act(async () => { scan.open(); });
    expect(JSON.stringify(renderer.toJSON())).toContain("Scanner active");
    await act(async () => { button(renderer!, "Cancel scan")?.props.onClick(); });
    expect(scan.cancels).toEqual(["user"]);
    expect(JSON.stringify(renderer.toJSON())).toContain("Closing scanner");
    expect(button(renderer, "Scan again")).toBeUndefined();
    await act(async () => { scan.close(); });
    expect(JSON.stringify(renderer.toJSON())).toContain("QR scanning was cancelled");
    expect(button(renderer, "Scan again")).toBeDefined();
  });

  it("ignores an opened signal from a completed attempt after retry begins", async () => {
    consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const first = deferredAttempt();
    const second = deferredAttempt();
    const attempts = [first.attempt, second.attempt];
    renderer = await renderFlow({ createAttempt: () => {
      const attempt = attempts.shift();
      if (attempt === undefined) throw new Error("unexpected scan");
      return attempt;
    } });

    await act(async () => { button(renderer!, "Scan QR code")?.props.onClick(); });
    await act(async () => { first.reject(new MobileQrScanError("scanner_error")); });
    await act(async () => { button(renderer!, "Scan again")?.props.onClick(); });
    await act(async () => { first.open(); });
    expect(JSON.stringify(renderer.toJSON())).toContain("Opening camera");
    expect(JSON.stringify(renderer.toJSON())).not.toContain("Scanner active");
    await act(async () => { second.open(); });
    expect(JSON.stringify(renderer.toJSON())).toContain("Scanner active");
  });

  it("ignores native close acknowledgement after the flow unmounts", async () => {
    const errors: unknown[][] = [];
    consoleError = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => { errors.push(args); });
    const scan = deferredAttempt({ closeOnCancel: false });
    renderer = await renderFlow({ createAttempt: () => scan.attempt });
    await act(async () => { button(renderer!, "Scan QR code")?.props.onClick(); scan.open(); });
    await act(async () => { button(renderer!, "Cancel scan")?.props.onClick(); });
    await act(async () => { renderer?.unmount(); });
    renderer = undefined;
    await act(async () => { scan.close(); });
    expect(errors.flat().join(" ")).not.toMatch(/unmounted component|state update/u);
  });

  it("cancels the active scan when its parent dismisses and unmounts the dialog", async () => {
    consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const calls: string[] = [];
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        Capacitor: {
          isNativePlatform: () => true,
          getPlatform: () => "android",
          Plugins: {
            T4QrScanner: {
              isSupported: () => Promise.resolve({ supported: true }),
              cameraPermission: () => Promise.resolve({ camera: "granted" }),
              requestCameraPermission: () => Promise.resolve({ camera: "granted" }),
              addListener: () => Promise.resolve({ remove: () => undefined }),
              startScan: ({ attemptId }: { readonly attemptId: string }) => {
                calls.push(`start:${attemptId}`);
                return new Promise<void>(() => undefined);
              },
              cancelScan: ({ attemptId }: { readonly attemptId: string }) => {
                calls.push(`cancel:${attemptId}`);
                return Promise.resolve();
              },
            },
          },
        },
        localStorage: new MemoryStorage(),
        location: { reload: () => undefined },
      },
    });
    await act(async () => { renderer = create(<MobileConnectionScreen mode="first-run" />); });
    await act(async () => { button(renderer!, "Scan QR code")?.props.onClick(); await Promise.resolve(); await Promise.resolve(); });
    expect(calls.some((call) => call.startsWith("start:"))).toBe(true);
    await act(async () => { renderer!.root.findByProps({ "aria-label": "Not now" }).props.onClick(); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    const attemptId = calls.find((call) => call.startsWith("start:"))?.slice("start:".length);
    expect(calls).toContain(`cancel:${attemptId}`);
    expect(JSON.stringify(renderer!.toJSON())).not.toContain("Pair this phone");
  });

  it.each([
    ["permission_denied", "Camera permission is needed"],
    ["permission_blocked", "Enable it in system settings"],
    ["scan_timeout", "timed out"],
    ["scanner_error", "could not start"],
    ["invalid_qr", "not a T4 private connection key"],
  ] as const)("renders safe %s guidance and allows retry", async (code, message) => {
    consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const scan = deferredAttempt();
    renderer = await renderFlow({ createAttempt: () => scan.attempt });
    await act(async () => { button(renderer!, "Scan QR code")?.props.onClick(); });
    await act(async () => { scan.reject(new MobileQrScanError(code)); });
    expect(JSON.stringify(renderer.toJSON())).toContain(message);
    expect(button(renderer, "Scan again")).toBeDefined();
  });

  it("previews a calm fingerprint and saves only after explicit confirmation", async () => {
    consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const scan = deferredAttempt();
    const saves: string[] = [];
    renderer = await renderFlow({ createAttempt: () => scan.attempt, save: (candidate) => { saves.push(candidate.invite); return true; } });
    await act(async () => { button(renderer!, "Scan QR code")?.props.onClick(); scan.resolve(); });
    expect(saves).toEqual([]);
    expect(JSON.stringify(renderer.toJSON())).toContain("AAAA AAAA AAAA AAAA");
    expect(JSON.stringify(renderer.toJSON())).toContain("Confirm connection");
    await act(async () => { button(renderer!, "Confirm connection")?.props.onClick(); });
    expect(saves).toEqual([INVITE]);
  });

  it("dismisses without persistence and routes paste through the same guarded save", async () => {
    consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const saves: string[] = [];
    const dismisses: string[] = [];
    renderer = await renderFlow({ save: (candidate) => { saves.push(candidate.invite); return true; }, onDismiss: () => dismisses.push("dismiss") });
    await act(async () => { button(renderer!, "Paste private key")?.props.onClick(); });
    const input = renderer.root.findByType("textarea");
    await act(async () => { input.props.onChange({ target: { value: INVITE } }); });
    await act(async () => { button(renderer!, "Review key")?.props.onClick(); });
    expect(saves).toEqual([]);
    await act(async () => { button(renderer!, "Not now")?.props.onClick(); });
    expect(saves).toEqual([]);
    expect(dismisses).toEqual(["dismiss"]);
  });

  it("reports a guarded double-confirm refusal without a second persistence", async () => {
    consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const scan = deferredAttempt();
    let calls = 0;
    renderer = await renderFlow({ createAttempt: () => scan.attempt, save: () => { calls += 1; return calls === 1; } });
    await act(async () => { button(renderer!, "Scan QR code")?.props.onClick(); scan.resolve(); });
    const confirm = button(renderer, "Confirm connection");
    await act(async () => { confirm?.props.onClick(); confirm?.props.onClick(); });
    expect(calls).toBe(1);
  });

  it.each(["scan", "paste"] as const)("refuses %s confirmation when Tailnet state appears during pairing", async (source) => {
    consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const scan = deferredAttempt();
    const storage = new MemoryStorage();
    const tailnet = parseTailnetBackend("https://appeared.tailnet.ts.net:8445");
    const originalBytes = JSON.stringify({ version: 2, activeOrigin: tailnet.origin, backends: [tailnet] });
    renderer = await renderFlow({
      createAttempt: () => scan.attempt,
      save: (candidate) => writeFirstRunPeerBackend(candidate, storage),
    });

    if (source === "scan") {
      await act(async () => { button(renderer!, "Scan QR code")?.props.onClick(); });
      storage.setItem(MOBILE_BACKEND_STORAGE_KEY, originalBytes);
      await act(async () => { scan.resolve(); });
    } else {
      await act(async () => { button(renderer!, "Paste private key")?.props.onClick(); });
      await act(async () => { renderer!.root.findByType("textarea").props.onChange({ target: { value: INVITE } }); });
      await act(async () => { button(renderer!, "Review key")?.props.onClick(); });
      storage.setItem(MOBILE_BACKEND_STORAGE_KEY, originalBytes);
    }

    await act(async () => { button(renderer!, "Confirm connection")?.props.onClick(); });
    expect(storage.getItem(MOBILE_BACKEND_STORAGE_KEY)).toBe(originalBytes);
    expect(JSON.stringify(renderer.toJSON())).toContain("Nothing was replaced");
  });
});
