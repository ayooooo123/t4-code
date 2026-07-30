import { describe, expect, it } from "vitest";

type VitestMockApi = {
  readonly vi: {
    mock(moduleName: string, factory: () => unknown): void;
  };
};

class MockDesktopLifecycle {
  start(): Promise<void> {
    return Promise.resolve();
  }
}

type AppEvent = "before-quit" | "will-quit" | "quit" | "window-all-closed";

type AppListener = (...args: unknown[]) => void;

class MockElectronApp {
  on(): this {
    return this;
  }

  removeListener(): this {
    return this;
  }

  quit(): void {}
}

const vitest = await import("vitest") as unknown as VitestMockApi;
vitest.vi.mock("electron", () => ({ app: new MockElectronApp() }));
vitest.vi.mock("../src/lifecycle.ts", () => ({ DesktopLifecycle: MockDesktopLifecycle }));

// Main bootstraps at module evaluation, so load it only after mocking native Electron.
const { bootstrapDesktopMain } = await import("../src/main.ts");

type ProcessEvent = "uncaughtException" | "unhandledRejection";
type ProcessListener = (reason: unknown) => void;

class FakeProcess {
  readonly platform = "linux";
  private readonly listeners = new Map<ProcessEvent, Set<ProcessListener>>();

  on(event: ProcessEvent, listener: ProcessListener): this {
    let eventListeners = this.listeners.get(event);
    if (eventListeners === undefined) {
      eventListeners = new Set();
      this.listeners.set(event, eventListeners);
    }
    eventListeners.add(listener);
    return this;
  }

  removeListener(event: ProcessEvent, listener: ProcessListener): this {
    this.listeners.get(event)?.delete(listener);
    return this;
  }

  emit(event: ProcessEvent, reason: unknown): void {
    for (const listener of this.listeners.get(event) ?? []) listener(reason);
  }

  listenerCount(event: ProcessEvent): number {
    return this.listeners.get(event)?.size ?? 0;
  }
}

class FakeApp {
  quitCalls = 0;
  private readonly listeners = new Map<AppEvent, Set<AppListener>>();

  on(event: AppEvent, listener: AppListener): this {
    let eventListeners = this.listeners.get(event);
    if (eventListeners === undefined) {
      eventListeners = new Set();
      this.listeners.set(event, eventListeners);
    }
    eventListeners.add(listener);
    return this;
  }

  removeListener(event: AppEvent, listener: AppListener): this {
    this.listeners.get(event)?.delete(listener);
    return this;
  }

  emit(event: AppEvent, ...args: unknown[]): void {
    for (const listener of this.listeners.get(event) ?? []) listener(...args);
  }

  quit(): void {
    this.quitCalls += 1;
  }
}

function runtime(start: () => Promise<void> = () => Promise.resolve()): {
  readonly app: FakeApp;
  readonly process: FakeProcess;
  readonly reports: string[];
  readonly lifecycle: { start(): Promise<void> };
} {
  return {
    app: new FakeApp(),
    process: new FakeProcess(),
    reports: [],
    lifecycle: { start },
  };
}

describe("main runtime failure policy", () => {
  it("reports bounded runtime rejections without quitting or duplicating listeners", async () => {
    const harness = runtime();
    await bootstrapDesktopMain({ ...harness, report: (message) => harness.reports.push(message) });

    for (let index = 0; index < 12; index += 1) {
      harness.process.emit("unhandledRejection", new Error(`browser failure ${index}`));
    }

    expect(harness.app.quitCalls).toBe(0);
    expect(harness.reports).toHaveLength(10);
    expect(harness.reports.at(-1)).toContain("further runtime rejections suppressed");

    await bootstrapDesktopMain({ ...harness, report: (message) => harness.reports.push(message) });
    expect(harness.process.listenerCount("unhandledRejection")).toBe(1);
    expect(harness.process.listenerCount("uncaughtException")).toBe(1);
  });

  it("keeps operational network timeouts recoverable by default", async () => {
    const harness = runtime();
    await bootstrapDesktopMain({ ...harness, report: (message) => harness.reports.push(message) });

    harness.process.emit("uncaughtException", new Error("connection timed out"));

    expect(harness.app.quitCalls).toBe(0);
    expect(harness.reports).toEqual([
      "[desktop] recoverable main exception: Error: connection timed out",
    ]);
  });

  it("keeps fetch connect timeouts recoverable through the error cause", async () => {
    const harness = runtime();
    await bootstrapDesktopMain({ ...harness, report: (message) => harness.reports.push(message) });
    const timeoutCause = new Error("connect timeout");
    Object.defineProperty(timeoutCause, "code", { value: "UND_ERR_CONNECT_TIMEOUT" });
    const error = new TypeError("fetch failed");
    Object.defineProperty(error, "cause", { value: timeoutCause });

    harness.process.emit("uncaughtException", error);

    expect(harness.app.quitCalls).toBe(0);
    expect(harness.reports).toEqual([
      "[desktop] recoverable main exception: TypeError: fetch failed",
    ]);
  });

  it("keeps non-timeout socket exceptions fatal", async () => {
    const harness = runtime();
    await bootstrapDesktopMain({ ...harness, report: (message) => harness.reports.push(message) });
    const error = new Error("socket hang up");
    Object.defineProperty(error, "code", { value: "ECONNRESET" });

    harness.process.emit("uncaughtException", error);

    expect(harness.app.quitCalls).toBe(1);
    expect(harness.reports[0]).toBe("[desktop] fatal main exception: Error: socket hang up");
  });


  it("quits once after a fatal lifecycle startup failure", async () => {
    const harness = runtime(async () => {
      throw new Error("startup failed");
    });

    await bootstrapDesktopMain({ ...harness, report: (message) => harness.reports.push(message) });

    expect(harness.app.quitCalls).toBe(1);
    expect(harness.reports).toHaveLength(2);
    expect(harness.reports[0]).toBe("[desktop] fatal startup failure: Error: startup failed");
    expect(harness.reports[1]).toContain("[desktop] app.quit requested: fatal startup failure");
  });

  it("reports normal Electron quit lifecycle events", async () => {
    const harness = runtime();
    await bootstrapDesktopMain({ ...harness, report: (message) => harness.reports.push(message) });

    harness.app.emit("before-quit");
    harness.app.emit("will-quit");
    harness.app.emit("quit", undefined, 0);

    expect(harness.reports).toEqual([
      "[desktop] before-quit received",
      "[desktop] will-quit received",
      "[desktop] quit completed: exitCode=0",
    ]);
  });

  it("keeps uncaught main exceptions fatal", async () => {
    const harness = runtime();
    await bootstrapDesktopMain({ ...harness, report: (message) => harness.reports.push(message) });

    harness.process.emit("uncaughtException", new Error("main invariant violated"));
    harness.process.emit("uncaughtException", new Error("another invariant violated"));

    expect(harness.app.quitCalls).toBe(1);
    expect(harness.reports).toHaveLength(3);
    expect(harness.reports[0]).toBe("[desktop] fatal main exception: Error: main invariant violated");
    expect(harness.reports[1]).toContain("[desktop] app.quit requested: fatal main exception");
    expect(harness.reports[2]).toBe("[desktop] fatal main exception: Error: another invariant violated");
  });
});
