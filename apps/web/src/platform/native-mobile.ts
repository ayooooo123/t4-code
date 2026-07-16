import { decodePeerInvite, deviceToken as validateDeviceToken, peerInviteMetadata } from "@t4-code/protocol";

const LEGACY_MOBILE_BACKEND_STORAGE_KEY = "t4-code:mobile-backend:v1";
export const MOBILE_BACKEND_STORAGE_KEY = "t4-code:mobile-backends:v2";

const MAX_URL_LENGTH = 2048;
const MAX_LABEL_LENGTH = 128;
const MAX_SAVED_MOBILE_BACKENDS = 16;

export type NativeMobilePlatform = "android" | "ios";

export interface StoredMobileBackend {
  readonly version: 1;
  readonly origin: string;
  readonly wsUrl: string;
  readonly label: string;
}
export interface StoredPeerMobileBackend {
  readonly version: 2;
  readonly kind: "peer";
  readonly invite: string;
  readonly label: string;
}
export type StoredMobileConnection = StoredMobileBackend | StoredPeerMobileBackend;

export interface StoredMobileBackendDirectory {
  readonly version: 2;
  readonly activeOrigin: string;
  readonly backends: readonly StoredMobileBackend[];
}

export interface NativeMobileBackendConfig {
  readonly origin: string;
  readonly wsUrl: string;
  readonly label: string;
  readonly deviceId?: string;
  readonly deviceToken?: string;
}

interface T4SecureStoragePlugin {
  getCredentials(options: {
    readonly hostKey: string;
    readonly migrateLegacy?: boolean;
  }): Promise<{
    readonly credentials: { readonly deviceId: string; readonly deviceToken: string } | null;
  }>;
  setCredentials(options: {
    readonly hostKey: string;
    readonly deviceId: string;
    readonly deviceToken: string;
  }): Promise<void>;
  clearCredentials(options: { readonly hostKey: string }): Promise<void>;
}

export interface NativeUpdateState {
  readonly currentVersion: string;
  readonly latestVersion?: string;
  readonly checkedAt?: number;
  readonly phase: "idle" | "checking" | "current" | "available" | "downloading" | "installer" | "error";
  readonly revision: number;
  readonly error?: string;
  readonly message?: string;
}

export interface T4UpdatePlugin {
  getState(): Promise<NativeUpdateState>;
  checkForUpdate(): Promise<NativeUpdateState>;
  /** Starts the native-owned download; later state changes report verification and installer handoff. */
  openUpdate(): Promise<NativeUpdateState>;
  addListener(
    eventName: "stateChanged",
    listener: (state: NativeUpdateState) => void,
  ): Promise<{ remove(): Promise<void> }>;
}
export interface T4PeerConnectionPlugin {
  open(options: { readonly publicKey: string; readonly attemptId: string }): Promise<{ readonly sessionId: string }>;
  cancelOpen(options: { readonly attemptId: string }): Promise<void>;
  write(options: { readonly sessionId: string; readonly data: string }): Promise<void>;
  close(options: { readonly sessionId: string }): Promise<void>;
  addListener(
    event: "peerData" | "peerClosed",
    listener: (payload: { readonly sessionId: string; readonly data?: string }) => void,
  ): Promise<{ readonly remove: () => Promise<void> | void }>;
}

export interface BarcodeScannerPlugin {
  isSupported(): Promise<{ readonly supported: boolean }>;
  startScan(options: {
    readonly formats: readonly ["QR_CODE"];
  }): Promise<void>;
  stopScan(): Promise<void>;
  addListener(
    event: "barcodesScanned",
    listener: (payload: { readonly barcodes: readonly { readonly rawValue?: string }[] }) => void,
  ): Promise<{ readonly remove: () => Promise<void> | void }>;
}

interface CapacitorBridge {
  readonly Plugins?: {
    readonly T4SecureStorage?: T4SecureStoragePlugin;
    readonly T4PeerConnection?: T4PeerConnectionPlugin;
    readonly BarcodeScanner?: BarcodeScannerPlugin;
    readonly T4Update?: T4UpdatePlugin;
  };
  readonly getPlatform?: () => string;
  readonly isNativePlatform?: () => boolean;
}

declare global {
  interface Window {
    Capacitor?: CapacitorBridge;
    __t4MobileBackend?: NativeMobileBackendConfig;
    __t4MobilePeerInvite?: string;
  }
}

export type MobileBootResult =
  | { readonly kind: "web" }
  | { readonly kind: "ready"; readonly backend: StoredMobileConnection }
  | { readonly kind: "setup"; readonly message?: string };

function secureStorage(): T4SecureStoragePlugin | null {
  return window.Capacitor?.Plugins?.T4SecureStorage ?? null;
}

export function peerConnection(): T4PeerConnectionPlugin | null {
  return window.Capacitor?.Plugins?.T4PeerConnection ?? null;
}

export function barcodeScanner(): BarcodeScannerPlugin | null {
  if (typeof window === "undefined") return null;
  return window.Capacitor?.Plugins?.BarcodeScanner ?? null;
}

export function nativeMobilePlatform(): NativeMobilePlatform | null {
  if (typeof window === "undefined") return null;
  const bridge = window.Capacitor;
  if (bridge?.isNativePlatform?.() !== true) return null;
  const platform = bridge.getPlatform?.();
  return platform === "android" || platform === "ios" ? platform : null;
}

export function nativeUpdatePlugin(): T4UpdatePlugin | null {
  if (nativeMobilePlatform() !== "android") return null;
  return window.Capacitor?.Plugins?.T4Update ?? null;
}

function requiredLabel(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_LABEL_LENGTH) {
    throw new Error("The saved host label is invalid.");
  }
  return value;
}

export function parseTailnetBackend(value: string): StoredMobileBackend {
  const trimmed = value.trim();
  if (trimmed.length === 0) throw new Error("Enter the HTTPS address shown by T4 Code on your computer.");
  if (trimmed.length > MAX_URL_LENGTH) throw new Error("That address is too long.");

  const candidate = trimmed.includes("://") ? trimmed : `https://${trimmed}`;
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new Error("Enter a valid HTTPS Tailnet address.");
  }
  if (parsed.protocol !== "https:") throw new Error("Use the HTTPS Tailnet address, not HTTP.");
  if (parsed.username !== "" || parsed.password !== "") throw new Error("The address cannot contain credentials.");
  if (parsed.pathname !== "/" || parsed.search !== "" || parsed.hash !== "") {
    throw new Error("Enter the host address only, without a path, query, or fragment.");
  }
  const hostname = parsed.hostname.toLowerCase();
  if (hostname === "ts.net" || !hostname.endsWith(".ts.net")) {
    throw new Error("Use the full Tailscale hostname ending in .ts.net.");
  }

  const origin = parsed.origin;
  const websocket = new URL(origin);
  websocket.protocol = "wss:";
  websocket.pathname = "/v1/ws";
  const deviceName = hostname.slice(0, hostname.indexOf("."));
  return {
    version: 1,
    origin,
    wsUrl: websocket.toString(),
    label: requiredLabel(`T4 on ${deviceName}`),
  };
}

export function parsePeerBackend(value: string): StoredPeerMobileBackend {
  const invite = value.trim();
  if (invite.length === 0 || invite.length > MAX_URL_LENGTH) throw new Error("Enter a private connection key.");
  const metadata = peerInviteMetadata(invite);
  decodePeerInvite(invite);
  return {
    version: 2,
    kind: "peer",
    invite,
    label: requiredLabel(`T4 private host ${metadata.desktopPublicKey.slice(0, 8)}`),
  };
}

/** Reads one QR code through Android's native scanner and validates it before it can be persisted. */
export async function scanPrivatePeerInvite(scanner: BarcodeScannerPlugin | null = barcodeScanner()): Promise<StoredPeerMobileBackend> {
  if (scanner === null) throw new Error("QR scanning is unavailable. Update T4 Code and try again.");
  const supported = await scanner.isSupported();
  if (!supported.supported) throw new Error("This device does not have a camera available for QR scanning.");

  let listener: { readonly remove: () => Promise<void> | void } | undefined;
  const result = await new Promise<{ readonly barcodes: readonly { readonly rawValue?: string }[] }>((resolve, reject) => {
    void (async () => {
      try {
        listener = await scanner.addListener("barcodesScanned", resolve);
        await scanner.startScan({ formats: ["QR_CODE"] });
      } catch (error) {
        reject(error);
      }
    })();
  }).finally(async () => {
    await scanner.stopScan().catch(() => undefined);
    await listener?.remove();
  });
  const value = result.barcodes.find((barcode) => typeof barcode.rawValue === "string")?.rawValue;
  if (value === undefined) throw new Error("No QR code was scanned. Try again.");
  try {
    return parsePeerBackend(value);
  } catch {
    throw new Error("That QR code is not a T4 private connection key.");
  }
}
type ReadableMobileStorage = Pick<Storage, "getItem">;
type MutableMobileStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

function parsedStorageValue(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error("The saved host list is damaged. Add the host again.");
  }
}

function storedMobileBackend(value: unknown): StoredMobileBackend {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("The saved host list is damaged. Add the host again.");
  }
  const data = value as Record<string, unknown>;
  if (data.version !== 1 || typeof data.origin !== "string") {
    throw new Error("The saved host list is from an unsupported app version.");
  }
  const parsed = parseTailnetBackend(data.origin);
  if (data.wsUrl !== parsed.wsUrl || data.label !== parsed.label) {
    throw new Error("The saved host list is inconsistent. Add the host again.");
  }
  return parsed;
}

function storedPeerMobileBackend(value: unknown): StoredPeerMobileBackend | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const data = value as Record<string, unknown>;
  if (data.version !== 2 || data.kind !== "peer" || typeof data.invite !== "string") return null;
  const parsed = parsePeerBackend(data.invite);
  if (data.label !== parsed.label) throw new Error("The saved private connection is inconsistent. Enter it again.");
  return parsed;
}

export function readStoredMobileConnection(storage: ReadableMobileStorage = window.localStorage): StoredMobileConnection | null {
  const raw = storage.getItem(MOBILE_BACKEND_STORAGE_KEY);
  if (raw !== null) {
    const value = parsedStorageValue(raw);
    const peer = storedPeerMobileBackend(value);
    if (peer !== null) return peer;
  }
  return readStoredMobileBackend(storage);
}

function storedMobileBackendDirectory(value: unknown): StoredMobileBackendDirectory {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("The saved host list is damaged. Add the host again.");
  }
  const data = value as Record<string, unknown>;
  if (
    data.version !== 2 ||
    typeof data.activeOrigin !== "string" ||
    !Array.isArray(data.backends) ||
    data.backends.length === 0 ||
    data.backends.length > MAX_SAVED_MOBILE_BACKENDS
  ) {
    throw new Error("The saved host list is from an unsupported app version.");
  }
  const backends = data.backends.map(storedMobileBackend);
  const origins = new Set(backends.map((backend) => backend.origin));
  if (origins.size !== backends.length || !origins.has(data.activeOrigin)) {
    throw new Error("The saved host list is inconsistent. Add the host again.");
  }
  return { version: 2, activeOrigin: data.activeOrigin, backends };
}

export function readStoredMobileBackendDirectory(
  storage: ReadableMobileStorage = window.localStorage,
): StoredMobileBackendDirectory | null {
  const raw = storage.getItem(MOBILE_BACKEND_STORAGE_KEY);
  if (raw !== null) {
    const value = parsedStorageValue(raw);
    if (storedPeerMobileBackend(value) !== null) return null;
    return storedMobileBackendDirectory(value);
  }
  const legacy = storage.getItem(LEGACY_MOBILE_BACKEND_STORAGE_KEY);
  if (legacy === null) return null;
  const backend = storedMobileBackend(parsedStorageValue(legacy));
  return { version: 2, activeOrigin: backend.origin, backends: [backend] };
}

export function readStoredMobileBackend(
  storage: ReadableMobileStorage = window.localStorage,
): StoredMobileBackend | null {
  const raw = storage.getItem(MOBILE_BACKEND_STORAGE_KEY);
  if (raw !== null && storedPeerMobileBackend(parsedStorageValue(raw)) !== null) {
    throw new Error("The saved connection is private, not a Tailnet host.");
  }
  const directory = readStoredMobileBackendDirectory(storage);
  return (
    directory?.backends.find((backend) => backend.origin === directory.activeOrigin) ?? null
  );
}

function writeStoredMobileBackendDirectory(
  directory: StoredMobileBackendDirectory,
  storage: MutableMobileStorage,
): void {
  storage.setItem(MOBILE_BACKEND_STORAGE_KEY, JSON.stringify(directory));
  storage.removeItem(LEGACY_MOBILE_BACKEND_STORAGE_KEY);
}

export function writeStoredMobileBackend(
  backend: StoredMobileBackend,
  storage: MutableMobileStorage = window.localStorage,
): void {
  const canonical = storedMobileBackend(backend);
  const current = readStoredMobileBackendDirectory(storage);
  const existing = current?.backends.filter((item) => item.origin !== canonical.origin) ?? [];
  if (existing.length >= MAX_SAVED_MOBILE_BACKENDS) {
    throw new Error(`This phone can save up to ${MAX_SAVED_MOBILE_BACKENDS} T4 hosts.`);
  }
  writeStoredMobileBackendDirectory(
    {
      version: 2,
      activeOrigin: canonical.origin,
      backends: [...existing, canonical],
    },
    storage,
  );
}

/** Replace damaged or unsupported address state from the first-run repair screen. */
export function replaceStoredMobileBackend(
  backend: StoredMobileBackend,
  storage: MutableMobileStorage = window.localStorage,
): void {
  const canonical = storedMobileBackend(backend);
  writeStoredMobileBackendDirectory(
    { version: 2, activeOrigin: canonical.origin, backends: [canonical] },
    storage,
  );
}

export function selectStoredMobileBackend(
  origin: string,
  storage: MutableMobileStorage = window.localStorage,
): void {
  const directory = readStoredMobileBackendDirectory(storage);
  if (directory === null || !directory.backends.some((backend) => backend.origin === origin)) {
    throw new Error("That saved host is no longer available.");
  }
  writeStoredMobileBackendDirectory({ ...directory, activeOrigin: origin }, storage);
}

export function writeStoredPeerBackend(
  backend: StoredPeerMobileBackend,
  storage: Pick<Storage, "setItem"> = window.localStorage,
): void {
  storage.setItem(MOBILE_BACKEND_STORAGE_KEY, JSON.stringify(backend));
}

export function currentNativeMobileBackend(): NativeMobileBackendConfig | null {
  if (typeof window === "undefined") return null;
  return window.__t4MobileBackend ?? null;
}

export function currentNativeMobilePeerInvite(): string | null {
  if (typeof window === "undefined") return null;
  return window.__t4MobilePeerInvite ?? null;
}

export async function prepareNativeMobileBackend(): Promise<MobileBootResult> {
  const platform = nativeMobilePlatform();
  if (platform === null) return { kind: "web" };
  document.documentElement.dataset.platform = platform;
  let shouldMigrateLegacyCredentials = false;
  let backend: StoredMobileConnection | null;
  try {
    shouldMigrateLegacyCredentials =
      window.localStorage.getItem(MOBILE_BACKEND_STORAGE_KEY) === null &&
      window.localStorage.getItem(LEGACY_MOBILE_BACKEND_STORAGE_KEY) !== null;
    backend = readStoredMobileConnection();
    if (backend?.version === 1 && window.localStorage.getItem(MOBILE_BACKEND_STORAGE_KEY) === null) {
      writeStoredMobileBackend(backend);
    }
  } catch (error) {
    return {
      kind: "setup",
      message: error instanceof Error ? error.message : "Enter the host address again.",
    };
  }
  if (backend === null) return { kind: "setup" };

  if (backend.version === 2) {
    delete window.__t4MobileBackend;
    window.__t4MobilePeerInvite = backend.invite;
    return { kind: "ready", backend };
  }

  const plugin = secureStorage();
  if (plugin === null) {
    return { kind: "setup", message: "The Android security bridge did not start. Close T4 Code and open it again." };
  }

  let credentials: { readonly deviceId: string; readonly deviceToken: string } | null = null;
  try {
    const result = await plugin.getCredentials({
      hostKey: backend.origin,
      migrateLegacy: shouldMigrateLegacyCredentials,
    });
    if (result.credentials !== null) {
      const deviceId = result.credentials.deviceId;
      if (deviceId.length === 0 || deviceId.length > 256) throw new Error("invalid device id");
      credentials = {
        deviceId,
        deviceToken: validateDeviceToken(result.credentials.deviceToken, "deviceToken"),
      };
    }
  } catch {
    await plugin.clearCredentials({ hostKey: backend.origin }).catch(() => undefined);
  }

  window.__t4MobileBackend = {
    origin: backend.origin,
    wsUrl: backend.wsUrl,
    label: backend.label,
    ...(credentials === null ? {} : credentials),
  };
  delete window.__t4MobilePeerInvite;
  return { kind: "ready", backend };
}

export async function persistNativeMobileCredentials(credentials: {
  readonly deviceId: string;
  readonly deviceToken: string;
}): Promise<void> {
  if (nativeMobilePlatform() === null) return;
  const plugin = secureStorage();
  if (plugin === null) throw new Error("Android secure storage is unavailable");
  const backend = readStoredMobileBackend();
  if (backend === null) throw new Error("The active mobile host is unavailable");
  await plugin.setCredentials({
    hostKey: backend.origin,
    deviceId: credentials.deviceId,
    deviceToken: validateDeviceToken(credentials.deviceToken, "deviceToken"),
  });
}

export async function removeNativeMobileBackend(
  origin: string,
  storage: MutableMobileStorage = window.localStorage,
): Promise<void> {
  const directory = readStoredMobileBackendDirectory(storage);
  if (directory === null || !directory.backends.some((backend) => backend.origin === origin)) {
    throw new Error("That saved host is no longer available.");
  }
  const plugin = secureStorage();
  if (plugin === null) throw new Error("Android secure storage is unavailable");

  // Remove non-secret routing metadata before touching the irreversible
  // credential. If secure deletion fails, restore the complete directory so a
  // failed removal never strands the selected host without an address.
  const backends = directory.backends.filter((backend) => backend.origin !== origin);
  const next = backends[0];
  if (next === undefined) {
    storage.removeItem(MOBILE_BACKEND_STORAGE_KEY);
    storage.removeItem(LEGACY_MOBILE_BACKEND_STORAGE_KEY);
  } else {
    writeStoredMobileBackendDirectory(
      {
        version: 2,
        activeOrigin: directory.activeOrigin === origin ? next.origin : directory.activeOrigin,
        backends,
      },
      storage,
    );
  }

  try {
    await plugin.clearCredentials({ hostKey: origin });
  } catch (error) {
    try {
      writeStoredMobileBackendDirectory(directory, storage);
    } catch {
      throw new Error(
        "Secure storage failed and T4 Code could not restore the saved host list. Close and reopen the app.",
      );
    }
    throw error;
  }
  if (window.__t4MobileBackend?.origin === origin) delete window.__t4MobileBackend;
}

export async function probeMobileBackend(
  backend: StoredMobileBackend,
  options: {
    readonly signal?: AbortSignal;
    readonly timeoutMs?: number;
    readonly WebSocketImpl?: typeof WebSocket;
  } = {},
): Promise<void> {
  const WebSocketImpl = options.WebSocketImpl ?? window.WebSocket;
  const timeoutMs = options.timeoutMs ?? 8_000;
  await new Promise<void>((resolve, reject) => {
    const signal = options.signal;
    if (signal?.aborted === true) {
      reject(new DOMException("The host check was cancelled.", "AbortError"));
      return;
    }
    let settled = false;
    const socket = new WebSocketImpl(backend.wsUrl);
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.removeEventListener("open", onOpen);
      socket.removeEventListener("error", onError);
      socket.removeEventListener("close", onClose);
      signal?.removeEventListener("abort", onAbort);
      if (error === undefined) resolve();
      else reject(error);
    };
    const onOpen = () => {
      finish();
      socket.close(1000, "T4 mobile connection check");
    };
    const onError = () =>
      finish(new Error("T4 Code could not reach that host. Check Tailscale and the address."));
    const onClose = () =>
      finish(new Error("The host closed the connection before T4 Code could start."));
    const onAbort = () => {
      finish(new DOMException("The host check was cancelled.", "AbortError"));
      socket.close();
    };
    const timer = setTimeout(() => {
      socket.close();
      finish(new Error("The host did not answer. Check that Tailscale and the T4 gateway are running."));
    }, timeoutMs);
    socket.addEventListener("open", onOpen);
    socket.addEventListener("error", onError);
    socket.addEventListener("close", onClose);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
