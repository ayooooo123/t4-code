import { app } from "electron";
import { DesktopLifecycle } from "./lifecycle.ts";
import { createDesktopQuitReporter } from "./quit-diagnostics.ts";
import { desktopClusterOperatorEnabled } from "./cluster-operator-flag.ts";

const MAX_RUNTIME_REJECTION_REPORTS = 10;
const MAX_FAILURE_MESSAGE_LENGTH = 1_024;

type DesktopAppEvent = "before-quit" | "will-quit" | "quit" | "window-all-closed";
type DesktopAppListener = (...args: unknown[]) => void;

type DesktopApp = {
  on(event: DesktopAppEvent, listener: DesktopAppListener): unknown;
  removeListener(event: DesktopAppEvent, listener: DesktopAppListener): unknown;
  quit(): void;
};

type MainProcess = {
  platform: string;
  on(event: "uncaughtException" | "unhandledRejection", listener: (reason: unknown) => void): unknown;
  removeListener(event: "uncaughtException" | "unhandledRejection", listener: (reason: unknown) => void): unknown;
};

type Lifecycle = {
  start(): Promise<void>;
};

export interface MainRuntimeOptions {
  readonly app: DesktopApp;
  readonly lifecycle: Lifecycle;
  readonly process: MainProcess;
  readonly report?: (message: string) => void;
  readonly isRecoverableException?: (error: unknown) => boolean;
}

interface InstalledProcessPolicy {
  readonly uncaughtException: (reason: unknown) => void;
  readonly unhandledRejection: (reason: unknown) => void;
}

interface InstalledQuitDiagnostics {
  readonly beforeQuit: () => void;
  readonly willQuit: () => void;
  readonly quit: (...args: unknown[]) => void;
}

const installedProcessPolicies = new WeakMap<MainProcess, InstalledProcessPolicy>();
const installedQuitDiagnostics = new WeakMap<DesktopApp, InstalledQuitDiagnostics>();
const windowCloseHandlers = new WeakMap<DesktopApp, () => void>();
const applicationShutdowns = new WeakMap<DesktopApp, { quitting: boolean }>();

function failureMessage(reason: unknown): string {
  try {
    let value: string;
    if (reason instanceof Error) value = `${reason.name}: ${reason.message}`;
    else if (typeof reason === "string") value = reason;
    else value = JSON.stringify(reason) ?? String(reason);
    return value.slice(0, MAX_FAILURE_MESSAGE_LENGTH);
  } catch {
    return "unprintable failure";
  }
}

const RECOVERABLE_EXCEPTION_CODES = new Set([
  "ETIMEDOUT",
  "UND_ERR_CONNECT_TIMEOUT",
]);

function recoverableExceptionCode(error: unknown, depth = 0): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  if ("code" in error && typeof error.code === "string") return error.code;
  if (depth >= 3 || !("cause" in error)) return undefined;
  return recoverableExceptionCode(error.cause, depth + 1);
}

function isDefaultRecoverableException(error: unknown): boolean {
  const code = recoverableExceptionCode(error);
  if (code !== undefined && RECOVERABLE_EXCEPTION_CODES.has(code)) return true;
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : undefined;
  if (message === undefined) return false;
  const normalized = message.toLocaleLowerCase();
  return normalized === "connection timed out" || normalized.includes("connect etimedout");
}


function quitStack(): string {
  const stack = new Error().stack;
  if (stack === undefined) return "unavailable";
  return stack.split("\n").slice(2, 8).map((line) => line.trim()).join(" | ");
}

function quitOnce(electronApp: DesktopApp, report: (message: string) => void, reason: string): void {
  let shutdown = applicationShutdowns.get(electronApp);
  if (shutdown === undefined) {
    shutdown = { quitting: false };
    applicationShutdowns.set(electronApp, shutdown);
  }
  if (shutdown.quitting) return;
  shutdown.quitting = true;
  report(`[desktop] app.quit requested: ${reason}; stack=${quitStack()}`);
  electronApp.quit();
}

function isRecoverable(
  error: unknown,
  classifier: ((error: unknown) => boolean) | undefined,
): boolean {
  try {
    return isDefaultRecoverableException(error) || classifier?.(error) === true;
  } catch {
    return isDefaultRecoverableException(error);
  }
}

function installWindowCloseHandler(
  electronApp: DesktopApp,
  platform: string,
  report: (message: string) => void,
): void {
  const previous = windowCloseHandlers.get(electronApp);
  if (previous !== undefined) electronApp.removeListener("window-all-closed", previous);
  const handler = (): void => {
    if (platform !== "darwin") quitOnce(electronApp, report, "all windows closed");
  };
  electronApp.on("window-all-closed", handler);
  windowCloseHandlers.set(electronApp, handler);
}

function installQuitDiagnostics(
  electronApp: DesktopApp,
  report: (message: string) => void,
): void {
  const previous = installedQuitDiagnostics.get(electronApp);
  if (previous !== undefined) {
    electronApp.removeListener("before-quit", previous.beforeQuit);
    electronApp.removeListener("will-quit", previous.willQuit);
    electronApp.removeListener("quit", previous.quit);
  }
  const beforeQuit = (): void => {
    report("[desktop] before-quit received");
  };
  const willQuit = (): void => {
    report("[desktop] will-quit received");
  };
  const quit = (...args: unknown[]): void => {
    const exitCode = typeof args.at(-1) === "number" ? args.at(-1) : "unknown";
    report(`[desktop] quit completed: exitCode=${exitCode}`);
  };
  electronApp.on("before-quit", beforeQuit);
  electronApp.on("will-quit", willQuit);
  electronApp.on("quit", quit);
  installedQuitDiagnostics.set(electronApp, { beforeQuit, willQuit, quit });
}

export function bootstrapDesktopMain(options: MainRuntimeOptions): Promise<void> {
  const report = options.report ?? createDesktopQuitReporter();
  installQuitDiagnostics(options.app, report);
  installWindowCloseHandler(options.app, options.process.platform, report);

  const previous = installedProcessPolicies.get(options.process);
  if (previous !== undefined) {
    options.process.removeListener("uncaughtException", previous.uncaughtException);
    options.process.removeListener("unhandledRejection", previous.unhandledRejection);
  }

  let rejectionReports = 0;
  const uncaughtException = (error: unknown): void => {
    if (isRecoverable(error, options.isRecoverableException)) {
      report(`[desktop] recoverable main exception: ${failureMessage(error)}`);
      return;
    }
    report(`[desktop] fatal main exception: ${failureMessage(error)}`);
    quitOnce(options.app, report, "fatal main exception");
  };
  const unhandledRejection = (reason: unknown): void => {
    if (rejectionReports >= MAX_RUNTIME_REJECTION_REPORTS) return;
    rejectionReports += 1;
    const suffix = rejectionReports === MAX_RUNTIME_REJECTION_REPORTS
      ? " (further runtime rejections suppressed)"
      : "";
    report(`[desktop] runtime rejection: ${failureMessage(reason)}${suffix}`);
  };
  options.process.on("uncaughtException", uncaughtException);
  options.process.on("unhandledRejection", unhandledRejection);
  installedProcessPolicies.set(options.process, { uncaughtException, unhandledRejection });

  try {
    return Promise.resolve(options.lifecycle.start()).catch((error: unknown) => {
      report(`[desktop] fatal startup failure: ${failureMessage(error)}`);
      quitOnce(options.app, report, "fatal startup failure");
    });
  } catch (error) {
    report(`[desktop] fatal startup failure: ${failureMessage(error)}`);
    quitOnce(options.app, report, "fatal startup failure");
    return Promise.resolve();
  }
}

const report = createDesktopQuitReporter();

const lifecycle = new DesktopLifecycle({
  clusterOperatorEnabled: desktopClusterOperatorEnabled(),
  report,
});
void bootstrapDesktopMain({
  app: app as unknown as DesktopApp,
  lifecycle,
  process: process as unknown as MainProcess,
  report,
});
