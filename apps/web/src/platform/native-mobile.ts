import { deviceToken as validateDeviceToken, type AndroidUpdateState } from "@t4-code/protocol";
import {
  DEFAULT_MOBILE_PROFILE_ID,
  MOBILE_BACKEND_STORAGE_KEY,
  parseTailnetBackend,
  type StoredMobileBackend,
  type StoredMobileBackendDirectory,
} from "./native-mobile-backend.ts";
import { parsePeerBackend, type StoredPeerMobileBackend } from "./mobile-connection-records.ts";

export {
  MOBILE_BACKEND_STORAGE_KEY,
  normalizeMobileProfileId,
  parseTailnetBackend,
  type StoredMobileBackend,
  type StoredMobileBackendDirectory,
} from "./native-mobile-backend.ts";

const LEGACY_MOBILE_BACKEND_STORAGE_KEY = "t4-code:mobile-backend:v1";
const LEGACY_MOBILE_BACKENDS_STORAGE_KEY = "t4-code:mobile-backends:v2";
const DEFAULT_PROFILE_ID = DEFAULT_MOBILE_PROFILE_ID;

const MAX_SAVED_MOBILE_BACKENDS = 16;
const SECURE_STORAGE_BRIDGE_TIMEOUT_MS = 1_500;

export type NativeMobilePlatform = "android" | "ios";

export interface NativeMobileBackendConfig {
  readonly endpointKey: string;
  readonly origin: string;
  readonly profileId: string;
  readonly wsUrl: string;
  readonly label: string;
  readonly deviceId?: string;
  readonly deviceToken?: string;
  readonly clusterOperatorEnabled?: true;
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

interface NativeMobileCredentials {
  readonly deviceId: string;
  readonly deviceToken: string;
}

export interface T4SpeechPlugin {
  speakText(options: { readonly text: string }): Promise<{ readonly accepted: boolean; readonly error?: string }>;
  stopSpeaking(): Promise<{ readonly accepted: boolean; readonly error?: string }>;
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

export type T4QrCameraPermission = "prompt" | "denied" | "blocked" | "granted";
export type T4QrScannerEventName = "scanResult" | "scanClosed" | "scanError";
export interface T4QrScannerEvent {
  readonly attemptId: string;
  readonly rawValue?: string;
  readonly reason?: "cancelled" | "background" | string;
  readonly code?: string;
}
export interface T4QrScannerPlugin {
  isSupported(): Promise<{ readonly supported: boolean }>;
  cameraPermission(): Promise<{ readonly camera: T4QrCameraPermission }>;
  requestCameraPermission(): Promise<{ readonly camera: T4QrCameraPermission }>;
  startScan(options: { readonly attemptId: string }): Promise<void>;
  cancelScan(options: { readonly attemptId: string }): Promise<void>;
  addListener(
    event: T4QrScannerEventName,
    listener: (payload: T4QrScannerEvent) => void,
  ): Promise<{ readonly remove: () => Promise<void> | void }>;
}

class SecureStorageBridgeTimeoutError extends Error {
  constructor() {
    super("Android secure storage did not answer.");
    this.name = "SecureStorageBridgeTimeoutError";
  }
}

async function withSecureStorageTimeout<T>(operation: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new SecureStorageBridgeTimeoutError()), SECURE_STORAGE_BRIDGE_TIMEOUT_MS);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function readSecureCredentials(
  plugin: T4SecureStoragePlugin,
  options: { readonly hostKey: string; readonly migrateLegacy: boolean },
): ReturnType<T4SecureStoragePlugin["getCredentials"]> {
  try {
    return await withSecureStorageTimeout(plugin.getCredentials(options));
  } catch (error) {
    if (!(error instanceof SecureStorageBridgeTimeoutError)) throw error;
    return await withSecureStorageTimeout(plugin.getCredentials(options));
  }
}

function validatedSecureCredentials(credentials: NativeMobileCredentials): NativeMobileCredentials {
  if (credentials.deviceId.length === 0 || credentials.deviceId.length > 256) {
    throw new Error("invalid device id");
  }
  return {
    deviceId: credentials.deviceId,
    deviceToken: validateDeviceToken(credentials.deviceToken, "deviceToken"),
  };
}

async function readBackendSecureCredentials(
  plugin: T4SecureStoragePlugin,
  backend: StoredMobileBackend,
  migrateLegacy: boolean,
): Promise<NativeMobileCredentials | null> {
  const current = await readSecureCredentials(plugin, {
    hostKey: backend.endpointKey,
    migrateLegacy: false,
  });
  if (current.credentials !== null) return validatedSecureCredentials(current.credentials);
  if (backend.profileId !== DEFAULT_PROFILE_ID) return null;

  const legacy = await readSecureCredentials(plugin, {
    hostKey: backend.origin,
    migrateLegacy,
  });
  if (legacy.credentials === null) return null;
  const credentials = validatedSecureCredentials(legacy.credentials);
  await withSecureStorageTimeout(plugin.setCredentials({ hostKey: backend.endpointKey, ...credentials }));
  await withSecureStorageTimeout(plugin.clearCredentials({ hostKey: backend.origin }));
  return credentials;
}
export type NativeUpdateState = AndroidUpdateState;

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

interface CapacitorBridge {
  readonly Plugins?: {
    readonly T4SecureStorage?: T4SecureStoragePlugin;
    readonly T4Update?: T4UpdatePlugin;
    readonly T4Speech?: T4SpeechPlugin;
    readonly T4PeerConnection?: T4PeerConnectionPlugin;
    readonly T4QrScanner?: T4QrScannerPlugin;
  };
  readonly getPlatform?: () => string;
  readonly isNativePlatform?: () => boolean;
}

declare global {
  interface Window {
    Capacitor?: CapacitorBridge;
    __t4MobileBackend?: NativeMobileBackendConfig;
    __t4MobilePeer?: MobilePeerConnectionConfig;
  }
}

export const MOBILE_PEER_BACKEND_STORAGE_KEY = "t4-code:mobile-peer:v1";

/** Renderer-local projection of the active HyperDHT private connection. */
export interface MobilePeerConnectionConfig {
  readonly invite: string;
  readonly label: string;
}

export type MobileBootResult =
  | { readonly kind: "web" }
  | { readonly kind: "ready"; readonly backend: StoredMobileBackend }
  | { readonly kind: "ready"; readonly peer: MobilePeerConnectionConfig }
  | { readonly kind: "setup"; readonly mode: "first-run"; readonly message?: string }
  | {
      readonly kind: "setup";
      readonly mode: "repair";
      readonly repairAction: "tailnet" | "unavailable";
      readonly message: string;
    };

function secureStorage(): T4SecureStoragePlugin | null {
  return window.Capacitor?.Plugins?.T4SecureStorage ?? null;
}

export function peerConnection(): T4PeerConnectionPlugin | null {
  return window.Capacitor?.Plugins?.T4PeerConnection ?? null;
}

export function nativeQrScanner(): T4QrScannerPlugin | null {
  return window.Capacitor?.Plugins?.T4QrScanner ?? null;
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
  if (data.version !== 1 && data.version !== 3) {
    throw new Error("The saved host list is from an unsupported app version.");
  }
  if (typeof data.origin !== "string") throw new Error("The saved host list is damaged. Add the host again.");
  if (
    data.clusterOperatorEnabled !== undefined &&
    (data.version !== 3 || data.clusterOperatorEnabled !== true)
  ) {
    throw new Error("The saved host list is damaged. Add the host again.");
  }
  const parsed = parseTailnetBackend(
    data.origin,
    data.version === 3 && typeof data.profileId === "string" ? data.profileId : undefined,
    data.version === 3 && data.clusterOperatorEnabled === true,
  );
  if (
    data.wsUrl !== parsed.wsUrl ||
    data.label !== parsed.label ||
    (data.version === 3 && data.endpointKey !== parsed.endpointKey) ||
    (data.version === 3 && data.clusterOperatorEnabled === true) !==
      (parsed.clusterOperatorEnabled === true)
  ) {
    throw new Error("The saved host list is inconsistent. Add the host again.");
  }
  return parsed;
}

function storedMobileBackendDirectory(value: unknown, version: 2 | 3): StoredMobileBackendDirectory {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("The saved host list is damaged. Add the host again.");
  }
  const data = value as Record<string, unknown>;
  const activeEndpointKey =
    version === 3
      ? data.activeEndpointKey
      : typeof data.activeOrigin === "string"
        ? parseTailnetBackend(data.activeOrigin, DEFAULT_PROFILE_ID).endpointKey
        : undefined;
  if (
    (version === 3 && data.version !== 3) ||
    (version === 2 && data.version !== 2) ||
    typeof activeEndpointKey !== "string" ||
    !Array.isArray(data.backends) ||
    data.backends.length === 0 ||
    data.backends.length > MAX_SAVED_MOBILE_BACKENDS
  ) {
    throw new Error("The saved host list is from an unsupported app version.");
  }
  const backends = data.backends.map(storedMobileBackend);
  const keys = new Set(backends.map((backend) => backend.endpointKey));
  if (keys.size !== backends.length || !keys.has(activeEndpointKey)) {
    throw new Error("The saved host list is inconsistent. Add the host again.");
  }
  return { version: 3, activeEndpointKey, backends };
}

export function readStoredMobileBackendDirectory(
  storage: ReadableMobileStorage = window.localStorage,
): StoredMobileBackendDirectory | null {
  const current = storage.getItem(MOBILE_BACKEND_STORAGE_KEY);
  if (current !== null) return storedMobileBackendDirectory(parsedStorageValue(current), 3);
  const legacyDirectory = storage.getItem(LEGACY_MOBILE_BACKENDS_STORAGE_KEY);
  if (legacyDirectory !== null) return storedMobileBackendDirectory(parsedStorageValue(legacyDirectory), 2);
  const legacy = storage.getItem(LEGACY_MOBILE_BACKEND_STORAGE_KEY);
  if (legacy === null) return null;
  const backend = storedMobileBackend(parsedStorageValue(legacy));
  return { version: 3, activeEndpointKey: backend.endpointKey, backends: [backend] };
}

export function readStoredMobileBackend(
  storage: ReadableMobileStorage = window.localStorage,
): StoredMobileBackend | null {
  const directory = readStoredMobileBackendDirectory(storage);
  return directory?.backends.find((backend) => backend.endpointKey === directory.activeEndpointKey) ?? null;
}

function writeStoredMobileBackendDirectory(
  directory: StoredMobileBackendDirectory,
  storage: MutableMobileStorage,
): void {
  storage.setItem(MOBILE_BACKEND_STORAGE_KEY, JSON.stringify(directory));
  storage.removeItem(LEGACY_MOBILE_BACKENDS_STORAGE_KEY);
  storage.removeItem(LEGACY_MOBILE_BACKEND_STORAGE_KEY);
}

export function writeStoredMobileBackend(
  backend: StoredMobileBackend,
  storage: MutableMobileStorage = window.localStorage,
): void {
  const canonical = storedMobileBackend(backend);
  const current = readStoredMobileBackendDirectory(storage);
  const existing = current?.backends.filter((item) => item.endpointKey !== canonical.endpointKey) ?? [];
  if (
    canonical.clusterOperatorEnabled === true &&
    existing.some((item) => item.clusterOperatorEnabled === true)
  ) {
    throw new Error("This phone can save only one cluster operator endpoint.");
  }
  if (current === null && existing.length >= MAX_SAVED_MOBILE_BACKENDS) {
    throw new Error(`This phone can save up to ${MAX_SAVED_MOBILE_BACKENDS} T4 hosts.`);
  }
  if (existing.length >= MAX_SAVED_MOBILE_BACKENDS) {
    throw new Error(`This phone can save up to ${MAX_SAVED_MOBILE_BACKENDS} T4 endpoints.`);
  }
  writeStoredMobileBackendDirectory(
    { version: 3, activeEndpointKey: canonical.endpointKey, backends: [...existing, canonical] },
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
    { version: 3, activeEndpointKey: canonical.endpointKey, backends: [canonical] },
    storage,
  );
}

function findEndpoint(directory: StoredMobileBackendDirectory, keyOrOrigin: string): StoredMobileBackend | undefined {
  return (
    directory.backends.find((backend) => backend.endpointKey === keyOrOrigin) ??
    directory.backends.find(
      (backend) => backend.origin === keyOrOrigin && backend.profileId === DEFAULT_PROFILE_ID,
    )
  );
}

export function selectStoredMobileBackend(
  endpointKey: string,
  storage: MutableMobileStorage = window.localStorage,
): void {
  const directory = readStoredMobileBackendDirectory(storage);
  const backend = directory === null ? undefined : findEndpoint(directory, endpointKey);
  if (directory === null || backend === undefined) throw new Error("That saved host is no longer available.");
  writeStoredMobileBackendDirectory({ ...directory, activeEndpointKey: backend.endpointKey }, storage);
}

function decodeStoredPeerBackend(raw: string): StoredPeerMobileBackend {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("The saved private connection is damaged. Scan the key again.");
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("The saved private connection is damaged. Scan the key again.");
  }
  const record = value as Record<string, unknown>;
  if (record.version !== 2 || record.kind !== "peer" || typeof record.invite !== "string") {
    throw new Error("The saved private connection is damaged. Scan the key again.");
  }
  const canonical = parsePeerBackend(record.invite);
  if (canonical.invite !== record.invite || canonical.label !== record.label) {
    throw new Error("The saved private connection is damaged. Scan the key again.");
  }
  return canonical;
}

export function readStoredPeerMobileBackend(
  storage: ReadableMobileStorage = window.localStorage,
): StoredPeerMobileBackend | null {
  const raw = storage.getItem(MOBILE_PEER_BACKEND_STORAGE_KEY);
  if (raw === null) return null;
  return decodeStoredPeerBackend(raw);
}

function firstRunStorageIsEmpty(storage: ReadableMobileStorage): boolean {
  try {
    return [
      storage.getItem(LEGACY_MOBILE_BACKEND_STORAGE_KEY),
      storage.getItem(LEGACY_MOBILE_BACKENDS_STORAGE_KEY),
      storage.getItem(MOBILE_BACKEND_STORAGE_KEY),
      storage.getItem(MOBILE_PEER_BACKEND_STORAGE_KEY),
    ].every((value) => value === null);
  } catch {
    return false;
  }
}

/**
 * The only persistence boundary used by first-run private pairing. Existing
 * bytes at any connection key are a refusal: a scan or paste preview must
 * never overwrite a record that appeared while the preview was open.
 */
export function writeFirstRunPeerBackend(
  candidate: StoredPeerMobileBackend,
  storage: Pick<Storage, "getItem" | "setItem"> = window.localStorage,
): boolean {
  let canonical: StoredPeerMobileBackend;
  try {
    canonical = parsePeerBackend(candidate.invite);
    if (canonical.label !== candidate.label) return false;
  } catch {
    return false;
  }
  if (!firstRunStorageIsEmpty(storage)) return false;
  try {
    storage.setItem(MOBILE_PEER_BACKEND_STORAGE_KEY, JSON.stringify(canonical));
    return true;
  } catch {
    return false;
  }
}

/** Guarded first-run equivalent for a verified Tailnet backend. */
export function writeFirstRunTailnetBackend(
  candidate: StoredMobileBackend,
  storage: MutableMobileStorage = window.localStorage,
): boolean {
  if (!firstRunStorageIsEmpty(storage)) return false;
  try {
    writeStoredMobileBackend(candidate, storage);
    return true;
  } catch {
    return false;
  }
}

/**
 * Explicit repair boundary for a QR/pasted private key. A healthy Tailnet
 * directory or a healthy stored private connection is never replaced here;
 * only unreadable state is.
 */
export function replaceBrokenMobileConnectionWithPeer(
  candidate: StoredPeerMobileBackend,
  storage: MutableMobileStorage = window.localStorage,
): boolean {
  let canonical: StoredPeerMobileBackend;
  try {
    canonical = parsePeerBackend(candidate.invite);
    if (canonical.label !== candidate.label) return false;
  } catch {
    return false;
  }
  let broken = false;
  try {
    if (readStoredMobileBackendDirectory(storage) !== null) return false;
    try {
      if (readStoredPeerMobileBackend(storage) !== null) return false;
    } catch {
      broken = true;
    }
  } catch {
    broken = true;
  }
  if (!broken) return false;
  try {
    storage.setItem(MOBILE_PEER_BACKEND_STORAGE_KEY, JSON.stringify(canonical));
    const written = storage.getItem(MOBILE_PEER_BACKEND_STORAGE_KEY);
    if (written === null) return false;
    decodeStoredPeerBackend(written);
  } catch {
    return false;
  }
  try { storage.removeItem(MOBILE_BACKEND_STORAGE_KEY); } catch { /* peer key is now authoritative */ }
  try { storage.removeItem(LEGACY_MOBILE_BACKENDS_STORAGE_KEY); } catch { /* peer key is now authoritative */ }
  try { storage.removeItem(LEGACY_MOBILE_BACKEND_STORAGE_KEY); } catch { /* peer key is now authoritative */ }
  return true;
}

export function currentNativeMobilePeer(): MobilePeerConnectionConfig | null {
  if (typeof window === "undefined") return null;
  return window.__t4MobilePeer ?? null;
}

export function currentNativeMobilePeerInvite(): string | null {
  return currentNativeMobilePeer()?.invite ?? null;
}

export function currentNativeMobileBackend(): NativeMobileBackendConfig | null {
  if (typeof window === "undefined") return null;
  return window.__t4MobileBackend ?? null;
}

export async function prepareNativeMobileBackend(): Promise<MobileBootResult> {
  const platform = nativeMobilePlatform();
  if (platform === null) return { kind: "web" };
  document.documentElement.dataset.platform = platform;
  delete window.__t4MobileBackend;
  delete window.__t4MobilePeer;
  let shouldMigrateLegacyCredentials = false;
  let backend: StoredMobileBackend | null;
  try {
    shouldMigrateLegacyCredentials =
      window.localStorage.getItem(MOBILE_BACKEND_STORAGE_KEY) === null &&
      (window.localStorage.getItem(LEGACY_MOBILE_BACKENDS_STORAGE_KEY) !== null ||
        window.localStorage.getItem(LEGACY_MOBILE_BACKEND_STORAGE_KEY) !== null);
    backend = readStoredMobileBackend();
    if (backend !== null && window.localStorage.getItem(MOBILE_BACKEND_STORAGE_KEY) === null) {
      const directory = readStoredMobileBackendDirectory();
      if (directory !== null) writeStoredMobileBackendDirectory(directory, window.localStorage);
    }
  } catch (error) {
    return {
      kind: "setup",
      mode: "repair",
      repairAction: "tailnet",
      message: error instanceof Error ? error.message : "Enter the host address again.",
    };
  }
  if (backend === null) {
    let peer: StoredPeerMobileBackend | null;
    try {
      peer = readStoredPeerMobileBackend();
    } catch {
      return {
        kind: "setup",
        mode: "repair",
        repairAction: "tailnet",
        message: "The saved private connection cannot be opened. Scan a replacement key or use a Tailnet address.",
      };
    }
    if (peer !== null) {
      window.__t4MobilePeer = { invite: peer.invite, label: peer.label };
      return { kind: "ready", peer: { invite: peer.invite, label: peer.label } };
    }
    return { kind: "setup", mode: "first-run" };
  }

  const plugin = secureStorage();
  if (plugin === null) {
    return {
      kind: "setup",
      mode: "repair",
      repairAction: "unavailable",
      message: "The Android security bridge did not start. Close T4 Code and open it again.",
    };
  }

  let credentials: NativeMobileCredentials | null = null;
  try {
    credentials = await readBackendSecureCredentials(
      plugin,
      backend,
      shouldMigrateLegacyCredentials,
    );
  } catch (error) {
    if (error instanceof SecureStorageBridgeTimeoutError) {
      return {
        kind: "setup",
        mode: "repair",
        repairAction: "unavailable",
        message: "Android secure storage did not answer. Close T4 Code and open it again.",
      };
    }
    await withSecureStorageTimeout(
      plugin.clearCredentials({ hostKey: backend.endpointKey }),
    ).catch(() => undefined);
  }

  window.__t4MobileBackend = {
    endpointKey: backend.endpointKey,
    origin: backend.origin,
    profileId: backend.profileId,
    wsUrl: backend.wsUrl,
    label: backend.label,
    ...(backend.clusterOperatorEnabled === true ? { clusterOperatorEnabled: true as const } : {}),
    ...(credentials === null ? {} : credentials),
  };
  return { kind: "ready", backend };
}

export function assertCurrentNativeMobileEndpoint(endpointKey: string): void {
  const configured = currentNativeMobileBackend();
  if (configured?.endpointKey !== endpointKey) {
    throw new Error("The active mobile host changed while pairing.");
  }
  const stored = readStoredMobileBackend();
  if (stored?.endpointKey !== endpointKey) {
    throw new Error("The active mobile host changed while pairing.");
  }
}

export async function persistNativeMobileCredentials(
  credentials: {
    readonly deviceId: string;
    readonly deviceToken: string;
  },
  endpointKey?: string,
): Promise<void> {
  if (nativeMobilePlatform() === null) return;
  if (endpointKey === undefined) throw new Error("The active mobile host is unavailable");
  const plugin = secureStorage();
  if (plugin === null) throw new Error("Android secure storage is unavailable");
  assertCurrentNativeMobileEndpoint(endpointKey);
  await plugin.setCredentials({
    hostKey: endpointKey,
    deviceId: credentials.deviceId,
    deviceToken: validateDeviceToken(credentials.deviceToken, "deviceToken"),
  });
}

export async function removeNativeMobileBackend(
  endpointKey: string,
  storage: MutableMobileStorage = window.localStorage,
): Promise<void> {
  const directory = readStoredMobileBackendDirectory(storage);
  const backend = directory === null ? undefined : findEndpoint(directory, endpointKey);
  if (directory === null || backend === undefined) {
    throw new Error("That saved host is no longer available.");
  }
  const plugin = secureStorage();
  if (plugin === null) throw new Error("Android secure storage is unavailable");

  // Remove routing metadata before irreversible credential deletion. Restore
  // the exact prior directory if secure deletion fails.
  const backends = directory.backends.filter((item) => item.endpointKey !== backend.endpointKey);
  const next = backends[0];
  if (next === undefined) {
    storage.removeItem(MOBILE_BACKEND_STORAGE_KEY);
    storage.removeItem(LEGACY_MOBILE_BACKENDS_STORAGE_KEY);
    storage.removeItem(LEGACY_MOBILE_BACKEND_STORAGE_KEY);
  } else {
    writeStoredMobileBackendDirectory(
      {
        version: 3,
        activeEndpointKey:
          directory.activeEndpointKey === backend.endpointKey
            ? next.endpointKey
            : directory.activeEndpointKey,
        backends,
      },
      storage,
    );
  }

  try {
    await plugin.clearCredentials({ hostKey: backend.endpointKey });
    if (backend.profileId === DEFAULT_PROFILE_ID) {
      await plugin.clearCredentials({ hostKey: backend.origin });
    }
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
  if (window.__t4MobileBackend?.endpointKey === backend.endpointKey) {
    delete window.__t4MobileBackend;
  }
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
