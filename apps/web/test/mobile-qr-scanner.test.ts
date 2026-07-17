import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  MobileQrScanError,
  buildPeerPairingCandidate,
  createMobileQrScanAttempt,
} from "../src/platform/mobile-qr-scanner.ts";
import {
  MobileQrAttemptOwner,
  buildPastedPeerPairingCandidate,
} from "../src/components/MobileConnectionScreen.tsx";
import type {
  T4QrScannerEvent,
  T4QrScannerEventName,
  T4QrScannerPlugin,
  T4QrCameraPermission,
} from "../src/platform/native-mobile.ts";

const KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const INVITE = `t4peer://v1/${KEY}/${KEY}`;
const originalWindow = globalThis.window;

type Listener = (event: T4QrScannerEvent) => void;

class FakeScanner implements T4QrScannerPlugin {
  readonly listeners = new Map<T4QrScannerEventName, Listener>();
  readonly registered: T4QrScannerEventName[] = [];
  readonly removed: T4QrScannerEventName[] = [];
  readonly calls: string[] = [];
  supported = true;
  permission: "prompt" | "denied" | "blocked" | "granted" = "granted";
  requestedPermission: "prompt" | "denied" | "blocked" | "granted" = "granted";
  failListenerAt = 0;
  throwSynchronouslyOnCancel = false;
  throwSynchronouslyOnRemove = false;
  startError: unknown;
  startPromise: Promise<void> = Promise.resolve();

  async isSupported(): Promise<{ readonly supported: boolean }> {
    this.calls.push("supported");
    return { supported: this.supported };
  }

  async cameraPermission(): Promise<{ readonly camera: T4QrCameraPermission }> {
    this.calls.push("permission");
    return { camera: this.permission };
  }

  async requestCameraPermission(): Promise<{ readonly camera: T4QrCameraPermission }> {
    this.calls.push("requestPermission");
    return { camera: this.requestedPermission };
  }

  async startScan(options: { readonly attemptId: string }): Promise<void> {
    this.calls.push(`start:${options.attemptId}`);
    if (this.startError !== undefined) throw this.startError;
    return this.startPromise;
  }

  cancelScan(options: { readonly attemptId: string }): Promise<void> {
    this.calls.push(`cancel:${options.attemptId}`);
    if (this.throwSynchronouslyOnCancel) throw new Error("private synchronous cancel failure");
    return Promise.resolve();
  }

  async addListener(event: T4QrScannerEventName, listener: Listener): Promise<{ remove(): Promise<void> }> {
    this.calls.push(`listen:${event}`);
    this.registered.push(event);
    if (this.registered.length === this.failListenerAt) throw new Error("native details must stay private");
    this.listeners.set(event, listener);
    return {
      remove: () => {
        this.removed.push(event);
        this.listeners.delete(event);
        if (this.throwSynchronouslyOnRemove) throw new Error("private synchronous remove failure");
        return Promise.resolve();
      },
    };
  }

  emit(event: T4QrScannerEventName, payload: Omit<T4QrScannerEvent, "attemptId"> & { readonly attemptId: string }): void {
    this.listeners.get(event)?.(payload as T4QrScannerEvent);
  }

  attemptId(): string {
    const call = this.calls.find((value) => value.startsWith("start:"));
    if (call === undefined) throw new Error("scan has not started");
    return call.slice("start:".length);
  }
}

async function flush(): Promise<void> {
  for (let index = 0; index < 12; index += 1) await Promise.resolve();
}

async function expectCode(promise: Promise<unknown>, code: MobileQrScanError["code"]): Promise<void> {
  await expect(promise).rejects.toMatchObject({ code });
}

afterEach(() => {
  vi.useRealTimers();
  Object.defineProperty(globalThis, "window", { configurable: true, value: originalWindow });
});

describe("mobile QR scan coordinator", () => {
  it("reports a missing native plugin without exposing implementation details", async () => {
    await expectCode(createMobileQrScanAttempt({ plugin: null }).result, "plugin_missing");
  });

  it("reports unsupported camera hardware", async () => {
    const plugin = new FakeScanner();
    plugin.supported = false;
    await expectCode(createMobileQrScanAttempt({ plugin }).result, "camera_unsupported");
  });

  it("requests a prompt permission and starts only after it is granted", async () => {
    const plugin = new FakeScanner();
    plugin.permission = "prompt";
    plugin.requestedPermission = "granted";
    const attempt = createMobileQrScanAttempt({ plugin });
    await flush();
    expect(plugin.calls.slice(0, 3)).toEqual(["supported", "permission", "requestPermission"]);
    expect(plugin.attemptId()).not.toBe("");
    plugin.emit("scanResult", { attemptId: plugin.attemptId(), rawValue: INVITE });
    await expect(attempt.result).resolves.toEqual(buildPeerPairingCandidate(INVITE));
  });

  it.each([
    ["denied", "permission_denied"],
    ["blocked", "permission_blocked"],
  ] as const)("maps %s camera permission", async (permission, code) => {
    const plugin = new FakeScanner();
    plugin.permission = permission;
    await expectCode(createMobileQrScanAttempt({ plugin }).result, code);
    expect(plugin.calls.some((call) => call.startsWith("start:"))).toBe(false);
  });

  it.each([
    ["denied", "permission_denied"],
    ["blocked", "permission_blocked"],
  ] as const)("maps %s after a permission prompt", async (permission, code) => {
    const plugin = new FakeScanner();
    plugin.permission = "prompt";
    plugin.requestedPermission = permission;
    await expectCode(createMobileQrScanAttempt({ plugin }).result, code);
  });

  it("registers every terminal listener before starting the native scan", async () => {
    const plugin = new FakeScanner();
    const attempt = createMobileQrScanAttempt({ plugin });
    await flush();
    expect(plugin.registered).toEqual(["scanResult", "scanClosed", "scanError"]);
    expect(plugin.calls.slice(-4).map((call) => call.replace(/start:.+/u, "start"))).toEqual([
      "listen:scanResult",
      "listen:scanClosed",
      "listen:scanError",
      "start",
    ]);
    plugin.emit("scanClosed", { attemptId: plugin.attemptId(), reason: "cancelled" });
    await expectCode(attempt.result, "scan_cancelled");
  });

  it("signals opened only after permission, listeners, and native start invocation", async () => {
    const plugin = new FakeScanner();
    let releasePermission!: (value: { readonly camera: "granted" }) => void;
    plugin.cameraPermission = () => new Promise((resolve) => { releasePermission = resolve; });
    let releaseStart!: () => void;
    plugin.startPromise = new Promise((resolve) => { releaseStart = resolve; });
    const attempt = createMobileQrScanAttempt({ plugin });
    let opened = false;
    void attempt.opened?.then(() => { opened = true; });

    await flush();
    expect(opened).toBe(false);
    expect(plugin.registered).toEqual([]);
    releasePermission({ camera: "granted" });
    await flush();
    expect(plugin.registered).toEqual(["scanResult", "scanClosed", "scanError"]);
    expect(plugin.calls.some((call) => call.startsWith("start:"))).toBe(true);
    expect(opened).toBe(true);

    plugin.emit("scanClosed", { attemptId: plugin.attemptId(), reason: "cancelled" });
    await expectCode(attempt.result, "scan_cancelled");
    releaseStart();
    await expect(attempt.closed).resolves.toBeUndefined();
  });

  it("settles cancellation immediately but acknowledges native close only after startScan returns", async () => {
    const plugin = new FakeScanner();
    let releaseStart!: () => void;
    plugin.startPromise = new Promise((resolve) => { releaseStart = resolve; });
    const attempt = createMobileQrScanAttempt({ plugin });
    await attempt.opened;
    let closed = false;
    void attempt.closed?.then(() => { closed = true; });

    attempt.cancel("user");
    await expectCode(attempt.result, "scan_cancelled");
    await flush();
    expect(closed).toBe(false);

    releaseStart();
    await expect(attempt.closed).resolves.toBeUndefined();
    expect(closed).toBe(true);
  });

  it("acknowledges closed immediately when native scanning was never invoked", async () => {
    const plugin = new FakeScanner();
    plugin.permission = "denied";
    const attempt = createMobileQrScanAttempt({ plugin });
    await expectCode(attempt.result, "permission_denied");
    await expect(attempt.closed).resolves.toBeUndefined();
    expect(plugin.calls.some((call) => call.startsWith("start:"))).toBe(false);
  });

  it.each([2, 3])("cleans earlier handles when listener %s registration fails and never starts", async (index) => {
    const plugin = new FakeScanner();
    plugin.failListenerAt = index;
    await expectCode(createMobileQrScanAttempt({ plugin }).result, "scanner_error");
    expect(plugin.removed).toEqual(index === 2 ? ["scanResult"] : ["scanResult", "scanClosed"]);
    expect(plugin.calls.some((call) => call.startsWith("start:"))).toBe(false);
  });

  it("validates a native result without persisting it", async () => {
    const plugin = new FakeScanner();
    const attempt = createMobileQrScanAttempt({ plugin });
    await flush();
    plugin.emit("scanResult", { attemptId: plugin.attemptId(), rawValue: INVITE });
    await expect(attempt.result).resolves.toEqual(buildPeerPairingCandidate(INVITE));
    expect(plugin.calls.some((call) => call.startsWith("cancel:"))).toBe(false);
    expect(plugin.removed).toEqual(["scanResult", "scanClosed", "scanError"]);
  });

  it("maps an invalid QR payload without persisting it", async () => {
    const plugin = new FakeScanner();
    const attempt = createMobileQrScanAttempt({ plugin });
    await flush();
    plugin.emit("scanResult", { attemptId: plugin.attemptId(), rawValue: "https://example.com" });
    await expectCode(attempt.result, "invalid_qr");
  });

  it("times out after the configured 60 seconds and cancels native scanning", async () => {
    vi.useFakeTimers();
    const plugin = new FakeScanner();
    const attempt = createMobileQrScanAttempt({ plugin, timeoutMs: 60_000 });
    await flush();
    const attemptId = plugin.attemptId();
    const rejection = attempt.result.catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(60_000);
    await expect(rejection).resolves.toMatchObject({ code: "scan_timeout" });
    expect(plugin.calls).toContain(`cancel:${attemptId}`);
  });

  it.each(["user", "background", "unmount"])("cancels safely for %s", async (reason) => {
    const plugin = new FakeScanner();
    const attempt = createMobileQrScanAttempt({ plugin });
    await flush();
    const attemptId = plugin.attemptId();
    attempt.cancel(reason);
    await expectCode(attempt.result, "scan_cancelled");
    expect(plugin.calls).toContain(`cancel:${attemptId}`);
  });

  it("settles unmount without waiting for registration and removes a handle that arrives later", async () => {
    const plugin = new FakeScanner();
    let release!: () => void;
    let removed = false;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    plugin.addListener = async (event, listener) => {
      plugin.registered.push(event);
      await gate;
      plugin.listeners.set(event, listener);
      return { remove: async () => { removed = true; } };
    };
    const attempt = createMobileQrScanAttempt({ plugin });
    await flush();
    attempt.cancel("unmount");
    await expectCode(attempt.result, "scan_cancelled");
    await expect(attempt.closed).resolves.toBeUndefined();
    expect(plugin.calls.some((call) => call.startsWith("start:"))).toBe(false);
    release();
    await flush();
    expect(removed).toBe(true);
  });

  it("applies the attempt deadline while hardware support is still pending and permits retry", async () => {
    vi.useFakeTimers();
    const plugin = new FakeScanner();
    plugin.isSupported = () => new Promise(() => undefined);
    const attempt = createMobileQrScanAttempt({ plugin, timeoutMs: 25 });
    const rejection = attempt.result.catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(25);
    await expect(rejection).resolves.toMatchObject({ code: "scan_timeout" });

    const retryPlugin = new FakeScanner();
    const retry = createMobileQrScanAttempt({ plugin: retryPlugin });
    await flush();
    retryPlugin.emit("scanResult", { attemptId: retryPlugin.attemptId(), rawValue: INVITE });
    await expect(retry.result).resolves.toEqual(buildPeerPairingCandidate(INVITE));
  });

  it("applies the attempt deadline while listener registration never resolves", async () => {
    vi.useFakeTimers();
    const plugin = new FakeScanner();
    plugin.addListener = () => new Promise(() => undefined);
    const attempt = createMobileQrScanAttempt({ plugin, timeoutMs: 25 });
    const rejection = attempt.result.catch((error: unknown) => error);
    await flush();
    await vi.advanceTimersByTimeAsync(25);
    await expect(rejection).resolves.toMatchObject({ code: "scan_timeout" });
    expect(plugin.calls.some((call) => call.startsWith("start:"))).toBe(false);
  });

  it("settles cancellation without waiting for native cancelScan", async () => {
    const plugin = new FakeScanner();
    plugin.cancelScan = () => new Promise(() => undefined);
    const attempt = createMobileQrScanAttempt({ plugin });
    await flush();
    attempt.cancel("user");
    await expectCode(attempt.result, "scan_cancelled");
  });

  it("settles a result without waiting for listener removal", async () => {
    const plugin = new FakeScanner();
    plugin.addListener = async (event, listener) => {
      plugin.listeners.set(event, listener);
      return { remove: () => new Promise(() => undefined) };
    };
    const attempt = createMobileQrScanAttempt({ plugin });
    await flush();
    plugin.emit("scanResult", { attemptId: plugin.attemptId(), rawValue: INVITE });
    await expect(attempt.result).resolves.toEqual(buildPeerPairingCandidate(INVITE));
  });

  it.each(["cancelled", "background"] as const)("maps native %s closure to cancellation", async (reason) => {
    const plugin = new FakeScanner();
    const attempt = createMobileQrScanAttempt({ plugin });
    await flush();
    plugin.emit("scanClosed", { attemptId: plugin.attemptId(), reason });
    await expect(attempt.result).rejects.toMatchObject({ code: "scan_cancelled", reason });
  });

  it("maps an unknown native closure reason to a stable scanner error", async () => {
    const plugin = new FakeScanner();
    const attempt = createMobileQrScanAttempt({ plugin });
    await flush();
    plugin.emit("scanClosed", { attemptId: plugin.attemptId(), reason: "native_secret" });
    await expect(attempt.result).rejects.toMatchObject({
      code: "scanner_error",
      reason: undefined,
      message: expect.not.stringMatching(/native_secret/u),
    });
  });

  it("settles cancellation when native cancel and listener removal throw synchronously", async () => {
    const plugin = new FakeScanner();
    plugin.throwSynchronouslyOnCancel = true;
    plugin.throwSynchronouslyOnRemove = true;
    const attempt = createMobileQrScanAttempt({ plugin });
    await flush();
    attempt.cancel("unmount");
    await expectCode(attempt.result, "scan_cancelled");
    expect(plugin.removed).toEqual(["scanResult", "scanClosed", "scanError"]);
  });

  it("settles a normal result when every listener removal throws synchronously", async () => {
    const plugin = new FakeScanner();
    plugin.throwSynchronouslyOnRemove = true;
    const attempt = createMobileQrScanAttempt({ plugin });
    await flush();
    plugin.emit("scanResult", { attemptId: plugin.attemptId(), rawValue: INVITE });
    await expect(attempt.result).resolves.toEqual(buildPeerPairingCandidate(INVITE));
    expect(plugin.removed).toEqual(["scanResult", "scanClosed", "scanError"]);
  });

  it("settles registration failure when an earlier listener removal throws synchronously", async () => {
    const plugin = new FakeScanner();
    plugin.failListenerAt = 2;
    plugin.throwSynchronouslyOnRemove = true;
    await expectCode(createMobileQrScanAttempt({ plugin }).result, "scanner_error");
    expect(plugin.removed).toEqual(["scanResult"]);
  });

  it("maps native scanner codes and rejected calls to stable scanner errors", async () => {
    const eventPlugin = new FakeScanner();
    const eventAttempt = createMobileQrScanAttempt({ plugin: eventPlugin });
    await flush();
    eventPlugin.emit("scanError", { attemptId: eventPlugin.attemptId(), code: "native_secret" });
    await expectCode(eventAttempt.result, "scanner_error");

    const rejectedPlugin = new FakeScanner();
    rejectedPlugin.startError = new Error("native secret");
    const rejected = createMobileQrScanAttempt({ plugin: rejectedPlugin }).result;
    await expectCode(rejected, "scanner_error");
    await expect(rejected).rejects.not.toThrow(/native secret/u);
  });

  it("accepts a result emitted before startScan resolves", async () => {
    const plugin = new FakeScanner();
    let resolveStart!: () => void;
    plugin.startPromise = new Promise<void>((resolve) => { resolveStart = resolve; });
    const attempt = createMobileQrScanAttempt({ plugin });
    await flush();
    plugin.emit("scanResult", { attemptId: plugin.attemptId(), rawValue: INVITE });
    await expect(attempt.result).resolves.toEqual(buildPeerPairingCandidate(INVITE));
    resolveStart();
  });

  it("ignores a late start resolution after cancellation", async () => {
    const plugin = new FakeScanner();
    let resolveStart!: () => void;
    plugin.startPromise = new Promise<void>((resolve) => { resolveStart = resolve; });
    const attempt = createMobileQrScanAttempt({ plugin });
    await flush();
    attempt.cancel("user");
    await expectCode(attempt.result, "scan_cancelled");
    resolveStart();
    await flush();
    expect(plugin.calls.filter((call) => call.startsWith("cancel:"))).toHaveLength(1);
  });

  it("settles once for duplicate events and ignores stale attempt IDs", async () => {
    const plugin = new FakeScanner();
    const attempt = createMobileQrScanAttempt({ plugin });
    await flush();
    plugin.emit("scanResult", { attemptId: "stale-attempt", rawValue: INVITE });
    plugin.emit("scanClosed", { attemptId: "stale-attempt", reason: "cancelled" });
    plugin.emit("scanResult", { attemptId: plugin.attemptId(), rawValue: INVITE });
    plugin.emit("scanError", { attemptId: plugin.attemptId(), code: "late_error" });
    await expect(attempt.result).resolves.toEqual(buildPeerPairingCandidate(INVITE));
  });

  it("can retry after every terminal path", async () => {
    const outcomes = [
      "plugin_missing",
      "unsupported",
      "permission_denied",
      "permission_blocked",
      "listener_failure",
      "result",
      "invalid_result",
      "cancelled",
      "background",
      "unknown_closure",
      "error",
      "rejected",
      "timeout",
      "explicit_cancel",
    ] as const;
    vi.useFakeTimers();
    for (const outcome of outcomes) {
      const plugin = new FakeScanner();
      if (outcome === "unsupported") plugin.supported = false;
      if (outcome === "permission_denied") plugin.permission = "denied";
      if (outcome === "permission_blocked") plugin.permission = "blocked";
      if (outcome === "listener_failure") plugin.failListenerAt = 2;
      if (outcome === "rejected") plugin.startError = new Error("private native failure");
      const attempt = createMobileQrScanAttempt({
        plugin: outcome === "plugin_missing" ? null : plugin,
        timeoutMs: 5,
      });
      const settled = attempt.result.then(
        (value) => ({ status: "resolved" as const, value }),
        (error: unknown) => ({ status: "rejected" as const, error }),
      );
      await flush();
      if (outcome === "result") plugin.emit("scanResult", { attemptId: plugin.attemptId(), rawValue: INVITE });
      if (outcome === "invalid_result") plugin.emit("scanResult", { attemptId: plugin.attemptId(), rawValue: "invalid" });
      if (outcome === "cancelled") plugin.emit("scanClosed", { attemptId: plugin.attemptId(), reason: "cancelled" });
      if (outcome === "background") plugin.emit("scanClosed", { attemptId: plugin.attemptId(), reason: "background" });
      if (outcome === "unknown_closure") plugin.emit("scanClosed", { attemptId: plugin.attemptId(), reason: "private" });
      if (outcome === "error") plugin.emit("scanError", { attemptId: plugin.attemptId(), code: "failure" });
      if (outcome === "timeout") await vi.advanceTimersByTimeAsync(5);
      if (outcome === "explicit_cancel") attempt.cancel("unmount");
      if (outcome === "result") await expect(settled).resolves.toMatchObject({ status: "resolved" });
      else await expect(settled).resolves.toMatchObject({ status: "rejected", error: expect.any(MobileQrScanError) });

      const retryPlugin = new FakeScanner();
      const retry = createMobileQrScanAttempt({ plugin: retryPlugin });
      await flush();
      retryPlugin.emit("scanResult", { attemptId: retryPlugin.attemptId(), rawValue: INVITE });
      await expect(retry.result).resolves.toEqual(buildPeerPairingCandidate(INVITE));
    }
  });
});

describe("peer pairing candidates", () => {
  it("maps pasted parser failures to the typed invalid QR error", () => {
    expect(() => buildPastedPeerPairingCandidate("https://example.com/not-t4")).toThrowError(
      expect.objectContaining({ code: "invalid_qr" }),
    );
  });

  it("builds the same non-persisted preview record for scanned and pasted input", async () => {
    let storageWrites = 0;
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: { localStorage: { setItem: () => { storageWrites += 1; } } },
    });
    const pasted = buildPastedPeerPairingCandidate(`  ${INVITE}  `);
    const plugin = new FakeScanner();
    const attempt = createMobileQrScanAttempt({ plugin });
    await flush();
    plugin.emit("scanResult", { attemptId: plugin.attemptId(), rawValue: INVITE });
    await expect(attempt.result).resolves.toEqual(pasted);
    expect(storageWrites).toBe(0);
  });
});

describe("mobile connection scan lifecycle", () => {
  it("cancels from the component unmount boundary and suppresses every late callback", async () => {
    let resolve!: (value: ReturnType<typeof buildPeerPairingCandidate>) => void;
    const result = new Promise<ReturnType<typeof buildPeerPairingCandidate>>((done) => { resolve = done; });
    const cancellations: string[] = [];
    const writes: string[] = [];
    const owner = new MobileQrAttemptOwner();
    const completion = owner.run(
      { result, cancel: (reason) => { cancellations.push(reason); } },
      {
        success: () => { writes.push("persist", "reload", "state"); },
        failure: () => { writes.push("error-state"); },
        settled: () => { writes.push("settled-state"); },
      },
    );

    owner.dispose();
    expect(cancellations).toEqual(["unmount"]);
    resolve(buildPeerPairingCandidate(INVITE));
    await completion;
    expect(writes).toEqual([]);
  });

  it("cancels a replaced flow and ignores its stale result", async () => {
    let resolveFirst!: (value: ReturnType<typeof buildPeerPairingCandidate>) => void;
    let resolveSecond!: (value: ReturnType<typeof buildPeerPairingCandidate>) => void;
    const firstCancellations: string[] = [];
    const successes: string[] = [];
    const owner = new MobileQrAttemptOwner();
    const first = owner.run(
      {
        result: new Promise((resolve) => { resolveFirst = resolve; }),
        cancel: (reason) => { firstCancellations.push(reason); },
      },
      { success: () => { successes.push("first"); }, failure: () => undefined, settled: () => undefined },
    );
    const second = owner.run(
      {
        result: new Promise((resolve) => { resolveSecond = resolve; }),
        cancel: () => undefined,
      },
      { success: () => { successes.push("second"); }, failure: () => undefined, settled: () => undefined },
    );

    expect(firstCancellations).toEqual(["replaced"]);
    resolveFirst(buildPeerPairingCandidate(INVITE));
    resolveSecond(buildPeerPairingCandidate(INVITE));
    await Promise.all([first, second]);
    expect(successes).toEqual(["second"]);
  });
});
