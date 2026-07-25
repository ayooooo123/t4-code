import {
  nativeQrScanner,
  type T4QrCameraPermission,
  type T4QrScannerEvent,
  type T4QrScannerEventName,
  type T4QrScannerPlugin,
} from "./native-mobile.ts";
import {
  parsePeerBackend,
  type StoredPeerMobileBackend,
} from "./mobile-connection-records.ts";

export type MobileQrScanErrorCode =
  | "plugin_missing"
  | "camera_unsupported"
  | "permission_denied"
  | "permission_blocked"
  | "scan_timeout"
  | "scan_cancelled"
  | "invalid_qr"
  | "scanner_error";

const ERROR_MESSAGES: Readonly<Record<MobileQrScanErrorCode, string>> = {
  plugin_missing: "QR scanning is unavailable. Update T4 Code and try again.",
  camera_unsupported: "This device does not have a camera available for QR scanning.",
  permission_denied: "Camera permission is needed to scan a connection key.",
  permission_blocked: "Camera access is blocked. Enable it in system settings and try again.",
  scan_timeout: "The QR scan timed out. Try again.",
  scan_cancelled: "QR scanning was cancelled.",
  invalid_qr: "That QR code is not a T4 private connection key.",
  scanner_error: "The QR scanner could not start. Try again.",
};

export class MobileQrScanError extends Error {
  readonly code: MobileQrScanErrorCode;
  readonly reason: string | undefined;

  constructor(code: MobileQrScanErrorCode, reason?: string) {
    super(ERROR_MESSAGES[code]);
    this.name = "MobileQrScanError";
    this.code = code;
    this.reason = reason;
  }
}

export interface MobileQrScanAttempt {
  /** Resolves only after native startScan has been successfully invoked. */
  readonly opened?: Promise<void>;
  /** Resolves when native startScan returns, or immediately if it was never invoked. */
  readonly closed?: Promise<void>;
  readonly result: Promise<StoredPeerMobileBackend>;
  cancel(reason: string): void;
}

interface MobileQrScanAttemptOptions {
  readonly plugin?: T4QrScannerPlugin | null;
  readonly timeoutMs?: number;
}

interface ListenerHandle {
  remove(): Promise<void> | void;
}

let nextAttempt = 0;

function attemptToken(): string {
  nextAttempt += 1;
  return `web-${Date.now().toString(36)}-${nextAttempt.toString(36)}`;
}

export function buildPeerPairingCandidate(value: string): StoredPeerMobileBackend {
  try {
    return parsePeerBackend(value);
  } catch {
    throw new MobileQrScanError("invalid_qr");
  }
}

function permissionError(permission: T4QrCameraPermission): MobileQrScanError | null {
  if (permission === "granted") return null;
  if (permission === "blocked") return new MobileQrScanError("permission_blocked");
  if (permission === "denied") return new MobileQrScanError("permission_denied");
  return new MobileQrScanError("scanner_error");
}

export function createMobileQrScanAttempt({
  plugin = nativeQrScanner(),
  timeoutMs = 60_000,
}: MobileQrScanAttemptOptions = {}): MobileQrScanAttempt {
  const attemptId = attemptToken();
  const handles: ListenerHandle[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  let terminal = false;
  let startInvoked = false;
  let nativeCancelRequested = false;
  let cleanupPromise: Promise<void> | undefined;
  let resolveOpened!: () => void;
  let resolveClosed!: () => void;
  let resolveResult!: (value: StoredPeerMobileBackend) => void;
  let rejectResult!: (error: MobileQrScanError) => void;
  const result = new Promise<StoredPeerMobileBackend>((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });
  const opened = new Promise<void>((resolve) => { resolveOpened = resolve; });
  const closed = new Promise<void>((resolve) => { resolveClosed = resolve; });

  const ignoreCleanupFailure = (action: () => Promise<void> | void): void => {
    try {
      void Promise.resolve(action()).catch(() => undefined);
    } catch {
      // Native cleanup is best-effort and never delays attempt settlement.
    }
  };

  const cleanup = (normalResult: boolean): Promise<void> => {
    cleanupPromise ??= Promise.resolve().then(() => {
      if (!normalResult && startInvoked && !nativeCancelRequested && plugin !== null) {
        nativeCancelRequested = true;
        ignoreCleanupFailure(() => plugin.cancelScan({ attemptId }));
      }
      const currentHandles = handles.splice(0);
      for (const handle of currentHandles) {
        ignoreCleanupFailure(() => handle.remove());
      }
    });
    return cleanupPromise;
  };

  const stopDeadline = (): void => {
    if (timer === undefined) return;
    clearTimeout(timer);
    timer = undefined;
  };

  const rejectOnce = (error: MobileQrScanError): void => {
    if (terminal) return;
    terminal = true;
    stopDeadline();
    if (!startInvoked) resolveClosed();
    rejectResult(error);
    void cleanup(false);
  };

  const resolveOnce = (candidate: StoredPeerMobileBackend): void => {
    if (terminal) return;
    terminal = true;
    stopDeadline();
    if (!startInvoked) resolveClosed();
    resolveResult(candidate);
    void cleanup(true);
  };

  const onEvent = (eventName: T4QrScannerEventName, event: T4QrScannerEvent): void => {
    if (terminal || event.attemptId !== attemptId) return;
    if (eventName === "scanResult") {
      try {
        if (typeof event.rawValue !== "string") throw new Error("invalid QR payload");
        resolveOnce(buildPeerPairingCandidate(event.rawValue));
      } catch {
        rejectOnce(new MobileQrScanError("invalid_qr"));
      }
      return;
    }
    if (eventName === "scanClosed") {
      const knownReason = event.reason === "cancelled" || event.reason === "background";
      rejectOnce(new MobileQrScanError(
        knownReason ? "scan_cancelled" : "scanner_error",
        knownReason ? event.reason : undefined,
      ));
      return;
    }
    rejectOnce(new MobileQrScanError("scanner_error"));
  };

  const registerListener = async (eventName: T4QrScannerEventName): Promise<void> => {
    if (plugin === null || terminal) return;
    const handle = await plugin.addListener(eventName, (event) => onEvent(eventName, event));
    if (terminal) {
      ignoreCleanupFailure(() => handle.remove());
      return;
    }
    handles.push(handle);
  };

  timer = setTimeout(() => rejectOnce(new MobileQrScanError("scan_timeout")), timeoutMs);

  void (async () => {
    if (plugin === null) {
      rejectOnce(new MobileQrScanError("plugin_missing"));
      return;
    }
    try {
      const support = await plugin.isSupported();
      if (terminal) return;
      if (!support.supported) {
        rejectOnce(new MobileQrScanError("camera_unsupported"));
        return;
      }

      let { camera } = await plugin.cameraPermission();
      if (terminal) return;
      if (camera === "prompt") {
        ({ camera } = await plugin.requestCameraPermission());
      }
      if (terminal) return;
      const denied = permissionError(camera);
      if (denied !== null) {
        rejectOnce(denied);
        return;
      }

      await registerListener("scanResult");
      await registerListener("scanClosed");
      await registerListener("scanError");
      if (terminal) return;

      startInvoked = true;
      try {
        const nativeSession = plugin.startScan({ attemptId });
        resolveOpened();
        await nativeSession;
      } finally {
        resolveClosed();
      }
    } catch {
      rejectOnce(new MobileQrScanError("scanner_error"));
    }
  })();

  return {
    opened,
    closed,
    result,
    cancel: (reason: string) => rejectOnce(new MobileQrScanError("scan_cancelled", reason)),
  };
}
