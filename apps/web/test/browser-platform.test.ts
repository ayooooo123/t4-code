import { createOmpClient, type OmpClient, type OmpClientOptions, type OmpTransport, type PublicServerFrame } from "@t4-code/client";
import { commandId, confirmationId, hostId, requestId } from "@t4-code/protocol";
import { describe, expect, it, afterEach } from "vite-plus/test";

import { resolveRendererPlatform } from "../src/platform/bridge.ts";
import { createBrowserShellPort, detectBackend } from "../src/platform/browser-shell-port.ts";
import { BrowserWebSocketTransport } from "../src/platform/browser-transport.ts";
import { CapacitorPeerTransport } from "../src/platform/peer-transport.ts";

const originalDocument = globalThis.document;
const originalWindow = globalThis.window;
const originalWebSocket = globalThis.WebSocket;

class FakeLifecycleTarget {
  visibilityState: DocumentVisibilityState = "visible";
  private readonly listeners = new Map<string, Set<EventListener>>();
  addEventListener(type: string, listener: EventListener): void {
    const listeners = this.listeners.get(type) ?? new Set<EventListener>();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }
  removeEventListener(type: string, listener: EventListener): void {
    this.listeners.get(type)?.delete(listener);
  }
  dispatch(type: string): void {
    const event = { type } as Event;
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

function setBrowserLocation(search: string): void {
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { location: { search } },
  });
}

function setBackendScript(payload: string): void {
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: { getElementById: () => ({ textContent: payload }) },
  });
}

afterEach(() => {
  Object.defineProperty(globalThis, "document", { configurable: true, value: originalDocument });
  Object.defineProperty(globalThis, "window", { configurable: true, value: originalWindow });
  Object.defineProperty(globalThis, "WebSocket", { configurable: true, value: originalWebSocket });
});

describe("browser platform boundary", () => {
  it("keeps no-config browser mode on the fixture path", () => {
    Object.defineProperty(globalThis, "document", { configurable: true, value: undefined });
    Object.defineProperty(globalThis, "window", { configurable: true, value: undefined });
    const platform = resolveRendererPlatform("linux");
    expect(platform.mode).toBe("browser");
    expect(platform.shell).toBeNull();
  });

  it("accepts explicit script and query config, but rejects invalid config", () => {
    setBackendScript(
      JSON.stringify({
        wsUrl: "wss://omp.example/v1/ws",
        label: "Remote OMP",
        deviceId: "browser-1",
        deviceToken: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      }),
    );
    expect(detectBackend()).toEqual({
      wsUrl: "wss://omp.example/v1/ws",
      label: "Remote OMP",
      deviceId: "browser-1",
      deviceToken: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    });

    Object.defineProperty(globalThis, "document", { configurable: true, value: undefined });
    setBrowserLocation("?backend=ws%3A%2F%2F127.0.0.1%2Fv1%2Fws&label=Query");
    expect(detectBackend()).toEqual({ wsUrl: "ws://127.0.0.1/v1/ws", label: "Query" });
    setBrowserLocation("?backend=ws%3A%2F%2F127.0.0.1%2Fv1%2Fws&token=leaked");
    expect(() => detectBackend()).toThrow(/browser auth must not be supplied/u);

    setBackendScript(JSON.stringify({ wsUrl: "https://not-websocket" }));
    expect(() => detectBackend()).toThrow(/invalid browser backend wsUrl/u);
  });

  it("prefers a prepared native backend without putting credentials in the URL", () => {
    Object.defineProperty(globalThis, "document", { configurable: true, value: undefined });
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        __t4PreparedMobileConnection: {
          hostId: "host_AAAAAAAAAAA",
          transportId: "tail_AAAAAAAAAAA",
          kind: "tailscale",
          origin: "https://host.tailnet.ts.net:8445",
          wsUrl: "wss://host.tailnet.ts.net:8445/v1/ws",
          label: "T4 on host",
          credentialScopeKey: "https://host.tailnet.ts.net:8445",
          credentials: {
            deviceId: "android-device",
            deviceToken: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
          },
        },
        location: { search: "" },
      },
    });
    expect(detectBackend()).toEqual({
      wsUrl: "wss://host.tailnet.ts.net:8445/v1/ws",
      label: "T4 on host",
      deviceId: "android-device",
      deviceToken: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    });
  });

  it("ignores obsolete mobile globals", () => {
    Object.defineProperty(globalThis, "document", { configurable: true, value: undefined });
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        __t4MobileBackend: { wsUrl: "wss://old.invalid/v1/ws", label: "Old" },
        __t4MobilePeerInvite: "t4peer://v1/old/old",
        location: { search: "" },
      },
    });
    expect(detectBackend()).toBeNull();
    expect(createBrowserShellPort()).toBeNull();
  });

  it("uses only the explicitly prepared transport without treating the logical host ID as OMP identity", async () => {
    const fakeClient = {
      state: "idle",
      connect: async () => undefined,
      close: async () => undefined,
      onFrame: () => () => undefined,
      onState: () => () => undefined,
      onError: () => () => undefined,
    };
    let tailOptions: OmpClientOptions | undefined;
    Object.defineProperty(globalThis, "document", { configurable: true, value: undefined });
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        __t4PreparedMobileConnection: {
          hostId: "host_LOGICALAAAAA", label: "Tail desktop", transportId: "tail_AAAAAAAAAAA",
          kind: "tailscale", origin: "https://tail.tailnet.ts.net:8445",
          wsUrl: "wss://tail.tailnet.ts.net:8445/v1/ws",
          credentialScopeKey: "https://tail.tailnet.ts.net:8445",
        },
        location: { search: "" },
      },
    });
    const tailShell = createBrowserShellPort({
      clientFactory: (options) => { tailOptions = options; return fakeClient as unknown as OmpClient; },
    });
    await tailShell?.connect({ targetId: "remote" });
    expect(tailOptions).toBeDefined();
    expect(tailOptions).not.toHaveProperty("expectedHostId");
    expect(tailOptions?.client).not.toHaveProperty("hostId");
    class OpeningWebSocket {
      static readonly OPEN = 1;
      readyState = OpeningWebSocket.OPEN;
      binaryType = "blob";
      private readonly listeners = new Map<string, Set<EventListener>>();
      constructor() { queueMicrotask(() => this.dispatch("open")); }
      addEventListener(type: string, listener: EventListener): void {
        const listeners = this.listeners.get(type) ?? new Set<EventListener>();
        listeners.add(listener);
        this.listeners.set(type, listeners);
      }
      removeEventListener(type: string, listener: EventListener): void { this.listeners.get(type)?.delete(listener); }
      dispatch(type: string): void { for (const listener of this.listeners.get(type) ?? []) listener({ type } as Event); }
      close(): void { this.readyState = 3; }
      send(): void {}
    }
    Object.defineProperty(globalThis, "WebSocket", { configurable: true, value: OpeningWebSocket });
    const tailTransport = await tailOptions?.transport();
    expect(tailTransport).toBeInstanceOf(BrowserWebSocketTransport);
    tailTransport?.close();

    let peerOptions: OmpClientOptions | undefined;
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        __t4PreparedMobileConnection: {
          hostId: "host_LOGICALBBBBB", label: "Peer desktop", transportId: "peer_AAAAAAAAAAA",
          kind: "hyperdht",
          invite: "t4peer://v1/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        },
        location: { search: "" },
      },
    });
    const peerShell = createBrowserShellPort({
      clientFactory: (options) => { peerOptions = options; return fakeClient as unknown as OmpClient; },
    });
    await peerShell?.connect({ targetId: "remote" });
    expect(peerOptions).toBeDefined();
    expect(peerOptions).not.toHaveProperty("expectedHostId");
    expect(peerOptions?.client).not.toHaveProperty("hostId");
    await expect(peerOptions?.transport()).rejects.toThrow(/native private connection is unavailable/u);
    expect(CapacitorPeerTransport.name).toBe("CapacitorPeerTransport");
  });

  it("exposes one remote target and no local service lifecycle", async () => {
    setBackendScript(JSON.stringify({ wsUrl: "wss://omp.example/v1/ws", label: "Remote OMP" }));
    const shell = createBrowserShellPort();
    expect(shell).not.toBeNull();
    if (shell === null) return;
    const result = await shell.listTargets();
    expect(result.targets).toEqual([
      expect.objectContaining({ targetId: "remote", kind: "remote", label: "Remote OMP" }),
    ]);
    expect(shell.serviceInspect).toBeUndefined();
    expect(shell.serviceStart).toBeUndefined();
    expect(shell.serviceStop).toBeUndefined();
  });

  it("wires coalesced lifecycle wakes to the active client and removes them on disconnect", async () => {
    setBackendScript(JSON.stringify({ wsUrl: "wss://omp.example/v1/ws" }));
    const windowTarget = new FakeLifecycleTarget();
    const documentTarget = new FakeLifecycleTarget();
    let wakes = 0;
    const fakeClient = {
      state: "ready",
      connect: async () => undefined,
      close: async () => undefined,
      wake: () => {
        wakes += 1;
      },
      onFrame: () => () => undefined,
      onState: () => () => undefined,
      onError: () => () => undefined,
    };
    const shell = createBrowserShellPort({
      clientFactory: () => fakeClient as unknown as OmpClient,
      lifecycle: { windowTarget, documentTarget },
    });
    if (shell === null) return;

    await shell.bootstrap();
    windowTarget.dispatch("online");
    windowTarget.dispatch("pageshow");
    await Promise.resolve();
    expect(wakes).toBe(1);

    await shell.disconnect({ targetId: "remote" });
    windowTarget.dispatch("online");
    await Promise.resolve();
    expect(wakes).toBe(1);
  });

  it("bounds transport URLs and cleans listeners on close", () => {
    expect(() => new BrowserWebSocketTransport({ url: "https://not-websocket" })).toThrow(
      /invalid browser transport URL/u,
    );
    expect(
      () => new BrowserWebSocketTransport({ url: "wss://omp.example/v1/ws", openTimeoutMs: 0 }),
    ).toThrow(/invalid browser transport open timeout/u);
    const transport = new BrowserWebSocketTransport({ url: "wss://omp.example/v1/ws" });
    const unsubscribeMessage = transport.onMessage(() => undefined);
    const unsubscribeClose = transport.onClose(() => undefined);
    const unsubscribeError = transport.onError(() => undefined);
    unsubscribeMessage();
    unsubscribeClose();
    unsubscribeError();
    transport.close();
    expect(() => transport.send("{}")).toThrow(/not connected/u);
  });

  it("bounds a browser WebSocket that never opens", async () => {
    let socketClosed = false;
    class StalledWebSocket {
      static readonly OPEN = 1;
      readonly readyState = 0;
      binaryType = "blob";
      closed = false;

      addEventListener(): void {}
      removeEventListener(): void {}
      send(): void {}
      close(): void {
        this.closed = true;
        socketClosed = true;
      }
    }
    Object.defineProperty(globalThis, "WebSocket", {
      configurable: true,
      value: StalledWebSocket,
    });
    const transport = new BrowserWebSocketTransport({
      url: "wss://omp.example/v1/ws",
      openTimeoutMs: 1,
    });
    await expect(transport.open()).rejects.toThrow(/connection timed out/u);
    expect(socketClosed).toBe(true);
  });

  it("settles an in-flight browser open when the transport closes", async () => {
    class StalledWebSocket {
      static readonly OPEN = 1;
      readonly readyState = 0;
      binaryType = "blob";

      addEventListener(): void {}
      removeEventListener(): void {}
      send(): void {}
      close(): void {}
    }
    Object.defineProperty(globalThis, "WebSocket", {
      configurable: true,
      value: StalledWebSocket,
    });
    const transport = new BrowserWebSocketTransport({ url: "wss://omp.example/v1/ws" });
    const opening = transport.open();
    transport.close();
    await expect(opening).rejects.toThrow(/closed while opening/u);
  });

  it("maps client results, stores pairing auth, and closes client on disconnect", async () => {
    setBackendScript(JSON.stringify({ wsUrl: "wss://omp.example/v1/ws" }));
    let capturedOptions: OmpClientOptions | undefined;
    let connectCalls = 0;
    let closed = false;
    let clientFrameListener: ((frame: PublicServerFrame) => void) | undefined;
    let fakeState: "pairing" | "ready" = "pairing";
    let confirmResponse = { requestId: "confirm", ok: true, type: "response", v: "omp-app/1" };
    let commandResponse: unknown = {
      requestId: "req",
      commandId: "cmd",
      ok: true,
      result: { value: 1 },
      type: "response",
      v: "0.1",
    };
    const fakeClient = {
      get state() {
        return fakeState;
      },
      connect: async () => {
        connectCalls += 1;
      },
      close: async () => {
        closed = true;
      },
      command: async () => commandResponse,
      confirm: async () => confirmResponse,
      pairStart: async () => {
        const callback = capturedOptions?.privilegedPairResult;
        if (callback === undefined) throw new Error("pair callback missing");
        await callback({
          deviceId: "browser-1",
          deviceToken: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        } as never);
        fakeState = "ready";
        return { type: "pair.ok" };
      },
      onFrame: (listener: (frame: PublicServerFrame) => void) => {
        clientFrameListener = listener;
        return () => {
          clientFrameListener = undefined;
        };
      },
      onState: () => () => undefined,
      onError: () => () => undefined,
    };
    const shell = createBrowserShellPort({
      clientFactory: (options) => {
        capturedOptions = options;
        return fakeClient as unknown as OmpClient;
      },
    });
    if (shell === null) return;
    const emittedFrames: PublicServerFrame[] = [];
    const stopFrames = shell.onServerFrame((event) => emittedFrames.push(event.frame));
    await shell.bootstrap();
    expect(connectCalls).toBe(0);
    await shell.connect({ targetId: "remote" });
    expect(connectCalls).toBe(1);
    expect(capturedOptions?.requestedFeatures).toContain("prompt.images");
    expect(capturedOptions?.requestedFeatures).toContain("transcript.images");
    expect(capturedOptions?.compatibilityRequestedFeatures).not.toContain("prompt.images");
    expect(capturedOptions?.compatibilityRequestedFeatures).not.toContain("transcript.images");
    const pair = await shell.pair({ targetId: "remote", code: "123456" });
    expect(pair.paired).toBe(true);
    expect(capturedOptions?.authentication?.()).toEqual({
      deviceId: "browser-1",
      deviceToken: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    });
    const command = await shell.command({
      targetId: "remote",
      intent: { hostId: hostId("host"), command: "session.list", args: {} },
    });
    expect(command).toMatchObject({
      requestId: "req",
      commandId: "cmd",
      accepted: true,
      result: { value: 1 },
    });
    commandResponse = {
      requestId: "req-rejected",
      commandId: "cmd-rejected",
      ok: false,
      type: "response",
      v: "omp-app/1",
      error: {
        code: "stale_revision",
        message: "session changed",
        details: { expectedRevision: "rev-1", actualRevision: "rev-2", token: "secret" },
      },
    };
    expect(
      await shell.command({
        targetId: "remote",
        intent: { hostId: hostId("host"), command: "session.list", args: {} },
      }),
    ).toMatchObject({
      accepted: false,
      error: {
        code: "stale_revision",
        message: "session changed",
        details: { expectedRevision: "rev-1", actualRevision: "rev-2" },
      },
    });
    clientFrameListener?.({
      v: "omp-app/1",
      type: "response",
      requestId: requestId("frame-request"),
      commandId: commandId("frame-command"),
      hostId: hostId("host"),
      command: "session.list",
      ok: false,
      error: {
        code: "outcome_unknown",
        message: "reader failed; Bearer live-frame-token",
        details: {
          diagnostic: "token=live-frame-detail",
          accessToken: "must-not-cross-browser-boundary",
        },
      },
    });
    const rejectedFrame = emittedFrames.at(-1);
    expect(rejectedFrame).toMatchObject({
      type: "response",
      error: {
        code: "outcome_unknown",
        message: "reader failed; [redacted]",
        details: { diagnostic: "token=[redacted]" },
      },
    });
    expect(JSON.stringify(rejectedFrame)).not.toContain("live-frame-token");
    expect(JSON.stringify(rejectedFrame)).not.toContain("live-frame-detail");
    expect(JSON.stringify(rejectedFrame)).not.toContain("must-not-cross-browser-boundary");
    const confirmationRequest = {
      targetId: "remote",
      confirmationId: confirmationId("confirm"),
      commandId: commandId("cmd"),
      hostId: hostId("host"),
      decision: "approve",
    } as const;
    const confirmation = await shell.confirm(confirmationRequest);
    expect(confirmation.accepted).toBe(true);

    confirmResponse = {
      requestId: "original-command-request",
      ok: false,
      type: "response",
      v: "omp-app/1",
      error: { code: "confirmation_denied", message: "command was denied" },
    } as never;
    expect((await shell.confirm({ ...confirmationRequest, decision: "deny" })).accepted).toBe(true);
    confirmResponse = {
      requestId: "confirm-invalid",
      ok: false,
      type: "response",
      v: "omp-app/1",
      error: { code: "confirmation_invalid", message: "confirmation is invalid or expired" },
    } as never;
    expect((await shell.confirm(confirmationRequest)).accepted).toBe(false);
    await shell.disconnect({ targetId: "remote" });
    stopFrames();
    expect(closed).toBe(true);
  });

  it("manages overlapping transport openings and prevents old ones from keeping sockets open or breaking new ones", async () => {
    setBackendScript(JSON.stringify({ wsUrl: "wss://omp.example/v1/ws" }));

    class ControllableWebSocket {
      static readonly OPEN = 1;
      readyState = 0; // CONNECTING
      binaryType = "blob";
      closed = false;
      closeCode: number | undefined;
      closeReason: string | undefined;
      url: string;
      protocols: string | string[] | undefined;
      private readonly listeners = new Map<string, Set<EventListener>>();

      static instances: ControllableWebSocket[] = [];

      constructor(url: string, protocols?: string | string[]) {
        this.url = url;
        this.protocols = protocols;
        ControllableWebSocket.instances.push(this);
      }

      addEventListener(type: string, listener: EventListener): void {
        const set = this.listeners.get(type) ?? new Set<EventListener>();
        set.add(listener);
        this.listeners.set(type, set);
      }

      removeEventListener(type: string, listener: EventListener): void {
        this.listeners.get(type)?.delete(listener);
      }

      send(_data: string): void {}

      close(code?: number, reason?: string): void {
        this.closed = true;
        this.closeCode = code;
        this.closeReason = reason;
        this.readyState = 3; // CLOSED
        const closeEvent = {
          code: code ?? 1000,
          reason: reason ?? "",
          type: "close",
        } as unknown as CloseEvent;
        for (const listener of this.listeners.get("close") ?? []) {
          listener(closeEvent);
        }
      }

      triggerOpen(): void {
        this.readyState = 1; // OPEN
        for (const listener of this.listeners.get("open") ?? []) {
          listener({ type: "open" } as unknown as Event);
        }
      }
    }

    Object.defineProperty(globalThis, "WebSocket", {
      configurable: true,
      value: ControllableWebSocket,
    });

    let capturedTransportFactory: (() => OmpTransport | Promise<OmpTransport>) | undefined;
    const shell = createBrowserShellPort({
      clientFactory: (options) => {
        capturedTransportFactory = options.transport;
        return {
          state: "idle",
          connect: async () => undefined,
          close: async () => undefined,
          wake: () => undefined,
          onFrame: () => () => undefined,
          onState: () => () => undefined,
          onError: () => () => undefined,
        } as unknown as OmpClient;
      },
    });

    if (shell === null) throw new Error("shell should not be null");
    await shell.bootstrap();

    expect(capturedTransportFactory).toBeDefined();

    // Start old invocation
    const p1 = Promise.resolve(capturedTransportFactory!());
    expect(ControllableWebSocket.instances.length).toBe(1);
    const ws1 = ControllableWebSocket.instances[0];
    if (ws1 === undefined) throw new Error("ws1 should be defined");

    // Start newer invocation
    const p2 = Promise.resolve(capturedTransportFactory!());
    expect(ControllableWebSocket.instances.length).toBe(2);
    const ws2 = ControllableWebSocket.instances[1];
    if (ws2 === undefined) throw new Error("ws2 should be defined");

    // Resolve the old invocation first
    ws1.triggerOpen();

    // The old one should reject as superseded and close its own socket
    await expect(p1).rejects.toThrow(/browser transport superseded/u);
    expect(ws1.closed).toBe(true);
    // The newer socket remains usable/unclosed
    expect(ws2.closed).toBe(false);

    // Resolve the newer invocation next
    ws2.triggerOpen();

    // The newer one resolves successfully to the transport
    const transport2 = await p2;
    expect(transport2).toBeDefined();
    expect(ws2.closed).toBe(false);
  });

  it("proves shell disconnect closes/rejects a factory-level pending open promptly before client transport resolution", async () => {
    setBackendScript(JSON.stringify({ wsUrl: "wss://omp.example/v1/ws" }));

    class ControllableWebSocket {
      static readonly OPEN = 1;
      readyState = 0; // CONNECTING
      binaryType = "blob";
      closed = false;
      closeCode: number | undefined;
      closeReason: string | undefined;
      url: string;
      protocols: string | string[] | undefined;
      private readonly listeners = new Map<string, Set<EventListener>>();

      static instances: ControllableWebSocket[] = [];

      constructor(url: string, protocols?: string | string[]) {
        this.url = url;
        this.protocols = protocols;
        ControllableWebSocket.instances.push(this);
      }

      addEventListener(type: string, listener: EventListener): void {
        const set = this.listeners.get(type) ?? new Set<EventListener>();
        set.add(listener);
        this.listeners.set(type, set);
      }

      removeEventListener(type: string, listener: EventListener): void {
        this.listeners.get(type)?.delete(listener);
      }

      send(_data: string): void {}

      close(code?: number, reason?: string): void {
        this.closed = true;
        this.closeCode = code;
        this.closeReason = reason;
        this.readyState = 3; // CLOSED
        const closeEvent = {
          code: code ?? 1000,
          reason: reason ?? "",
          type: "close",
        } as unknown as CloseEvent;
        for (const listener of this.listeners.get("close") ?? []) {
          listener(closeEvent);
        }
      }
    }

    Object.defineProperty(globalThis, "WebSocket", {
      configurable: true,
      value: ControllableWebSocket,
    });

    let capturedTransportFactory: (() => OmpTransport | Promise<OmpTransport>) | undefined;
    const shell = createBrowserShellPort({
      clientFactory: (options) => {
        capturedTransportFactory = options.transport;
        return {
          state: "idle",
          connect: async () => undefined,
          close: async () => undefined,
          wake: () => undefined,
          onFrame: () => () => undefined,
          onState: () => () => undefined,
          onError: () => () => undefined,
        } as unknown as OmpClient;
      },
    });

    if (shell === null) throw new Error("shell should not be null");
    await shell.bootstrap();

    // Start pending open
    const p = Promise.resolve(capturedTransportFactory!());
    expect(ControllableWebSocket.instances.length).toBe(1);
    const ws = ControllableWebSocket.instances[0];
    if (ws === undefined) throw new Error("ws should be defined");
    expect(ws.closed).toBe(false);

    // Disconnect should reject the pending open promptly
    await shell.disconnect({ targetId: "remote" });
    await expect(p).rejects.toThrow(/closed while opening/u);
    expect(ws.closed).toBe(true);
  });

  it("asserts duplicate wake events do not create parallel opens where the existing lifecycle seam supports it", async () => {
    setBackendScript(JSON.stringify({ wsUrl: "wss://omp.example/v1/ws" }));

    class ControllableWebSocket {
      static readonly OPEN = 1;
      readyState = 0; // CONNECTING
      binaryType = "blob";
      closed = false;
      closeCode: number | undefined;
      closeReason: string | undefined;
      url: string;
      protocols: string | string[] | undefined;
      private readonly listeners = new Map<string, Set<EventListener>>();

      static instances: ControllableWebSocket[] = [];

      constructor(url: string, protocols?: string | string[]) {
        this.url = url;
        this.protocols = protocols;
        ControllableWebSocket.instances.push(this);
      }

      addEventListener(type: string, listener: EventListener): void {
        const set = this.listeners.get(type) ?? new Set<EventListener>();
        set.add(listener);
        this.listeners.set(type, set);
      }

      removeEventListener(type: string, listener: EventListener): void {
        this.listeners.get(type)?.delete(listener);
      }

      send(_data: string): void {}

      close(code?: number, reason?: string): void {
        this.closed = true;
        this.closeCode = code;
        this.closeReason = reason;
        this.readyState = 3; // CLOSED
        const closeEvent = {
          code: code ?? 1000,
          reason: reason ?? "",
          type: "close",
        } as unknown as CloseEvent;
        for (const listener of this.listeners.get("close") ?? []) {
          listener(closeEvent);
        }
      }

      triggerOpen(): void {
        this.readyState = 1; // OPEN
        for (const listener of this.listeners.get("open") ?? []) {
          listener({ type: "open" } as unknown as Event);
        }
      }
    }

    Object.defineProperty(globalThis, "WebSocket", {
      configurable: true,
      value: ControllableWebSocket,
    });

    class SpyLifecycleTarget {
      visibilityState: DocumentVisibilityState = "visible";
      readonly listeners = new Map<string, Set<EventListener>>();
      readonly calls = new Map<string, number>();

      addEventListener(type: string, listener: EventListener): void {
        this.calls.set(type, (this.calls.get(type) ?? 0) + 1);
        const set = this.listeners.get(type) ?? new Set<EventListener>();
        set.add(listener);
        this.listeners.set(type, set);
      }

      removeEventListener(type: string, listener: EventListener): void {
        this.listeners.get(type)?.delete(listener);
      }

      dispatch(type: string): void {
        const event = { type } as unknown as Event;
        for (const listener of this.listeners.get(type) ?? []) {
          listener(event);
        }
      }
    }

    const windowTarget = new SpyLifecycleTarget();
    const documentTarget = new SpyLifecycleTarget();
    let transportInvocations = 0;
    let capturedTransport: (() => OmpTransport | Promise<OmpTransport>) | undefined;

    const shell = createBrowserShellPort({
      clientFactory: (options) => {
        capturedTransport = options.transport;
        options.transport = async () => {
          transportInvocations++;
          return capturedTransport!();
        };
        return createOmpClient(options);
      },
      lifecycle: { windowTarget, documentTarget },
    });

    if (shell === null) throw new Error("shell should not be null");

    // Bootstrap. This binds the lifecycle and sets up the client (initially idle).
    await shell.bootstrap();

    // Assert that each event listener is bound exactly once.
    expect(windowTarget.calls.get("online")).toBe(1);
    expect(windowTarget.calls.get("pageshow")).toBe(1);
    expect(documentTarget.calls.get("visibilitychange")).toBe(1);

    // Call connect multiple times. Each call calls ensureLifecycle(),
    // which should NOT duplicate event listener bindings.
    await shell.connect({ targetId: "remote" });
    await shell.connect({ targetId: "remote" });

    expect(windowTarget.calls.get("online")).toBe(1);
    expect(windowTarget.calls.get("pageshow")).toBe(1);
    expect(documentTarget.calls.get("visibilitychange")).toBe(1);

    // Now trigger duplicate wake events while the client is connecting.
    // The first connect (from shell.connect()) has already started the transport opening process,
    // so we should have 1 transport invocation pending.
    expect(transportInvocations).toBe(1);
    expect(ControllableWebSocket.instances.length).toBe(1);
    const ws1 = ControllableWebSocket.instances[0];
    if (ws1 === undefined) throw new Error("ws1 should be defined");

    // Trigger wake events. Since the client is in "connecting" state,
    // these should be coalesced and processed, but should NOT invoke the transport factory again.
    windowTarget.dispatch("online");
    windowTarget.dispatch("pageshow");
    // Let the event queue flush (using microtask flush).
    await Promise.resolve();

    // Still exactly 1 transport invocation (no parallel opens created).
    expect(transportInvocations).toBe(1);
    expect(ControllableWebSocket.instances.length).toBe(1);

    // Open the socket so that it connects successfully.
    ws1.triggerOpen();
    // Let it resolve.
    await Promise.resolve();

    await shell.disconnect({ targetId: "remote" });
  });
});
