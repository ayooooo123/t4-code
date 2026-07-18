import { deviceToken as validateDeviceToken } from "@t4-code/protocol";

import {
  MobileConnectionUserError,
  parsePeerBackend,
  parseTailnetBackend,
  peerDesktopFingerprint,
  type StoredMobileBackend,
  type StoredMobileConnection,
  type StoredPeerMobileBackend,
} from "./mobile-connection-records.ts";
import {
  MOBILE_HOST_DIRECTORY_STORAGE_KEY,
  activeMobileHost,
  parseMobileHostDirectory,
  type MobileHost,
  type MobileHostDirectory,
} from "./mobile-host-schema.ts";
import {
  commitPreparedMobileHostMigration,
  decodeStoredMobileBackend,
  decodeStoredMobileBackendDirectory,
  decodeStoredPeerMobileBackend,
  prepareMobileHostDirectoryLoad,
  type MobileHostMigrationIdKind,
  type StoredMobileBackendDirectory,
} from "./mobile-host-storage.ts";

export {
  MobileConnectionUserError,
  parsePeerBackend,
  parseTailnetBackend,
  type StoredMobileBackend,
  type StoredMobileConnection,
  type StoredPeerMobileBackend,
} from "./mobile-connection-records.ts";
export { MOBILE_HOST_DIRECTORY_STORAGE_KEY } from "./mobile-host-schema.ts";
export type { StoredMobileBackendDirectory } from "./mobile-host-storage.ts";

const LEGACY_MOBILE_BACKEND_STORAGE_KEY = "t4-code:mobile-backend:v1";
export const MOBILE_BACKEND_STORAGE_KEY = "t4-code:mobile-backends:v2";

const MAX_SAVED_MOBILE_BACKENDS = 16;

export type NativeMobilePlatform = "android" | "ios";

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

interface CapacitorBridge {
  readonly Plugins?: {
    readonly T4SecureStorage?: T4SecureStoragePlugin;
    readonly T4PeerConnection?: T4PeerConnectionPlugin;
    readonly T4QrScanner?: T4QrScannerPlugin;
    readonly T4Update?: T4UpdatePlugin;
  };
  readonly getPlatform?: () => string;
  readonly isNativePlatform?: () => boolean;
}

declare global {
  interface Window {
    Capacitor?: CapacitorBridge;
    __t4PreparedMobileConnection?: PreparedMobileConnection;
    __t4MobileBackend?: NativeMobileBackendConfig;
    __t4MobilePeerInvite?: string;
  }
}

interface PreparedMobileConnectionBase {
  readonly hostId: string;
  readonly label: string;
  readonly transportId: string;
}

export type PreparedMobileConnection =
  | (PreparedMobileConnectionBase & {
      readonly kind: "tailscale";
      readonly origin: string;
      readonly wsUrl: string;
      readonly credentialScopeKey: string;
      readonly credentials?: { readonly deviceId: string; readonly deviceToken: string };
    })
  | (PreparedMobileConnectionBase & {
      readonly kind: "hyperdht";
      readonly invite: string;
    });

export type MobileBootResult =
  | { readonly kind: "web" }
  | {
      readonly kind: "ready";
      readonly host: MobileHost;
      readonly directory: MobileHostDirectory;
      readonly connection: PreparedMobileConnection;
    }
  | { readonly kind: "setup"; readonly mode: "first-run"; readonly message?: string }
  | {
      readonly kind: "setup";
      readonly mode: "repair";
      readonly repairAction: "tailnet" | "upgrade" | "unavailable";
      readonly message: string;
    };

/** Identifies validated corrupt state without ever exposing its raw details. */
class StoredMobileStateError extends Error {}

function secureStorage(): T4SecureStoragePlugin | null {
  return window.Capacitor?.Plugins?.T4SecureStorage ?? null;
}

export function peerConnection(): T4PeerConnectionPlugin | null {
  return window.Capacitor?.Plugins?.T4PeerConnection ?? null;
}

export function nativeQrScanner(): T4QrScannerPlugin | null {
  if (typeof window === "undefined") return null;
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
    throw new StoredMobileStateError("damaged saved host list");
  }
}

function storedMobileBackend(value: unknown): StoredMobileBackend {
  try {
    return decodeStoredMobileBackend(value);
  } catch {
    throw new StoredMobileStateError("inconsistent saved host list");
  }
}

function storedPeerMobileBackend(value: unknown): StoredPeerMobileBackend | null {
  try {
    return decodeStoredPeerMobileBackend(value);
  } catch {
    throw new StoredMobileStateError("invalid private connection");
  }
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
  try {
    return decodeStoredMobileBackendDirectory(value);
  } catch {
    throw new StoredMobileStateError("inconsistent saved host list");
  }
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

function firstRunStorageIsEmpty(storage: Pick<Storage, "getItem">): boolean {
  try {
    const existing = [
      storage.getItem(LEGACY_MOBILE_BACKEND_STORAGE_KEY),
      storage.getItem(MOBILE_BACKEND_STORAGE_KEY),
      storage.getItem(MOBILE_HOST_DIRECTORY_STORAGE_KEY),
    ];
    return existing.every((value) => value === null);
  } catch {
    return false;
  }
}

/**
 * The only persistence boundary used by first-run private pairing.
 *
 * Existing bytes are deliberately treated as opaque ownership markers: this
 * function neither parses nor removes them. All reads happen synchronously
 * immediately before the write, so a scan or paste preview cannot overwrite a
 * Tailnet record that appeared while the preview was open. A read failure is a
 * refusal, as is a repeated confirmation.
 */
export function writeFirstRunPeerBackend(
  candidate: StoredPeerMobileBackend,
  storage: Pick<Storage, "getItem" | "setItem"> = window.localStorage,
): boolean {
  const canonical = parsePeerBackend(candidate.invite);
  if (canonical.label !== candidate.label) return false;
  if (!firstRunStorageIsEmpty(storage)) return false;
  try {
    storage.setItem(MOBILE_BACKEND_STORAGE_KEY, JSON.stringify(canonical));
    return true;
  } catch {
    return false;
  }
}

/**
 * Explicit repair boundary for a QR/pasted private key.
 *
 * A valid directory is never replaced here. Unreadable generations are
 * snapshotted, checked again immediately before the write, and retained until
 * the canonical v3 replacement has been read back successfully.
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

  const nextId = (kind: MobileHostMigrationIdKind): string => {
    const random = globalThis.crypto?.randomUUID?.().replaceAll("-", "") ??
      `${Date.now().toString(36)}${Math.random().toString(36).slice(2).padEnd(16, "0")}`;
    return `${kind}_${random}`.slice(0, 64);
  };
  let originalV3: string | null;
  let originalV2: string | null;
  let originalLegacy: string | null;
  try {
    originalV3 = storage.getItem(MOBILE_HOST_DIRECTORY_STORAGE_KEY);
    originalV2 = storage.getItem(MOBILE_BACKEND_STORAGE_KEY);
    originalLegacy = storage.getItem(LEGACY_MOBILE_BACKEND_STORAGE_KEY);
    if (prepareMobileHostDirectoryLoad(storage, nextId).kind !== "repair") return false;
    if (
      storage.getItem(MOBILE_HOST_DIRECTORY_STORAGE_KEY) !== originalV3 ||
      storage.getItem(MOBILE_BACKEND_STORAGE_KEY) !== originalV2 ||
      storage.getItem(LEGACY_MOBILE_BACKEND_STORAGE_KEY) !== originalLegacy
    ) {
      return false;
    }
  } catch {
    return false;
  }

  const hostId = nextId("host");
  const transportId = nextId("hyperdht");
  const directory = parseMobileHostDirectory({
    version: 3,
    activeHostId: hostId,
    hosts: [{
      id: hostId,
      label: canonical.label,
      transports: [{
        id: transportId,
        kind: "hyperdht",
        invite: canonical.invite,
        desktopFingerprint: peerDesktopFingerprint(canonical.invite),
      }],
      preferredTransportIds: [transportId],
      lastConnection: null,
    }],
  });
  const replacement = JSON.stringify(directory);
  try {
    storage.setItem(MOBILE_HOST_DIRECTORY_STORAGE_KEY, replacement);
    const written = storage.getItem(MOBILE_HOST_DIRECTORY_STORAGE_KEY);
    if (written !== replacement) throw new Error("saved repair did not verify");
    parseMobileHostDirectory(JSON.parse(written));
  } catch {
    try {
      if (originalV3 === null) storage.removeItem(MOBILE_HOST_DIRECTORY_STORAGE_KEY);
      else storage.setItem(MOBILE_HOST_DIRECTORY_STORAGE_KEY, originalV3);
    } catch {
      // Restoration is best effort when the platform storage itself is broken.
    }
    return false;
  }

  try { storage.removeItem(MOBILE_BACKEND_STORAGE_KEY); } catch { /* v3 is authoritative */ }
  try { storage.removeItem(LEGACY_MOBILE_BACKEND_STORAGE_KEY); } catch { /* v3 is authoritative */ }
  return true;
}

/** Guarded first-run equivalent for a verified Tailnet backend. */
export function writeFirstRunTailnetBackend(
  candidate: StoredMobileBackend,
  storage: Pick<Storage, "getItem" | "setItem"> = window.localStorage,
): boolean {
  let canonical: StoredMobileBackend;
  try {
    canonical = storedMobileBackend(candidate);
  } catch {
    return false;
  }
  if (!firstRunStorageIsEmpty(storage)) return false;
  const directory: StoredMobileBackendDirectory = {
    version: 2,
    activeOrigin: canonical.origin,
    backends: [canonical],
  };
  try {
    storage.setItem(MOBILE_BACKEND_STORAGE_KEY, JSON.stringify(directory));
    return true;
  } catch {
    return false;
  }
}

export function currentNativeMobileBackend(): NativeMobileBackendConfig | null {
  if (typeof window === "undefined") return null;
  const connection = window.__t4PreparedMobileConnection;
  if (connection?.kind !== "tailscale") return null;
  return {
    origin: connection.origin,
    wsUrl: connection.wsUrl,
    label: connection.label,
    ...(connection.credentials ?? {}),
  };
}

export function currentNativeMobilePeerInvite(): string | null {
  if (typeof window === "undefined") return null;
  const connection = window.__t4PreparedMobileConnection;
  return connection?.kind === "hyperdht" ? connection.invite : null;
}

export function currentPreparedMobileConnection(): PreparedMobileConnection | null {
  if (typeof window === "undefined") return null;
  return window.__t4PreparedMobileConnection ?? null;
}

export async function prepareNativeMobileBackend(): Promise<MobileBootResult> {
  const platform = nativeMobilePlatform();
  if (platform === null) return { kind: "web" };
  delete window.__t4PreparedMobileConnection;
  delete window.__t4MobileBackend;
  delete window.__t4MobilePeerInvite;
  document.documentElement.dataset.platform = platform;
  const nextId = (kind: MobileHostMigrationIdKind): string => {
    const random = globalThis.crypto?.randomUUID?.().replaceAll("-", "") ??
      `${Date.now().toString(36)}${Math.random().toString(36).slice(2).padEnd(16, "0")}`;
    return `${kind}_${random}`.slice(0, 64);
  };
  let observedV3: string | null;
  try {
    observedV3 = window.localStorage.getItem(MOBILE_HOST_DIRECTORY_STORAGE_KEY);
  } catch {
    return {
      kind: "setup",
      mode: "repair",
      repairAction: "unavailable",
      message: "T4 Code cannot read saved connection storage. Close and reopen the app, then check system storage settings.",
    };
  }
  const prepared = prepareMobileHostDirectoryLoad(window.localStorage, nextId);
  if (prepared.kind === "empty") return { kind: "setup", mode: "first-run" };
  if (prepared.kind === "repair") {
    if (observedV3 !== null) {
      return {
        kind: "setup",
        mode: "repair",
        repairAction: "upgrade",
        message: "A newer saved host directory is present but is not available in this build.",
      };
    }
    return mobileMigrationRepair("tailnet");
  }

  const directory = prepared.directory;
  const host = activeMobileHost(directory);
  const connection = projectedMobileConnection(host);
  if (prepared.kind === "existing") {
    if (connection.kind === "hyperdht") return readyMobileBoot(directory, host, connection);
    const plugin = secureStorage();
    if (plugin === null) return mobileMigrationRepair("unavailable");
    let credentials: { readonly deviceId: string; readonly deviceToken: string } | null = null;
    try {
      const result = await plugin.getCredentials({
        hostKey: connection.credentialScopeKey,
        migrateLegacy: false,
      });
      if (result.credentials !== null) credentials = validatedNativeCredentials(result.credentials);
    } catch {
      try { await plugin.clearCredentials({ hostKey: connection.credentialScopeKey }); } catch { /* best effort */ }
    }
    return readyMobileBoot(directory, host, withPreparedCredentials(connection, credentials));
  }

  const plugin = secureStorage();
  let credentials: { readonly deviceId: string; readonly deviceToken: string } | null = null;
  if (prepared.legacyOrigin !== undefined) {
    if (plugin === null) {
      if (connection.kind === "hyperdht") return readyMobileBoot(directory, host, connection);
      return mobileMigrationRepair("unavailable");
    }
    try {
      const result = await plugin.getCredentials({
        hostKey: prepared.legacyOrigin,
        migrateLegacy: true,
      });
      if (result.credentials !== null) credentials = validatedNativeCredentials(result.credentials);
    } catch {
      return readyMobileBoot(directory, host, connection);
    }
    if (connection.kind !== "tailscale" || connection.credentialScopeKey !== prepared.legacyOrigin) {
      credentials = null;
    }
  } else if (connection.kind === "tailscale") {
    if (plugin === null) return mobileMigrationRepair("unavailable");
    try {
      const result = await plugin.getCredentials({ hostKey: connection.credentialScopeKey, migrateLegacy: false });
      if (result.credentials !== null) credentials = validatedNativeCredentials(result.credentials);
    } catch {
      return readyMobileBoot(directory, host, connection);
    }
  }

  const committed = commitPreparedMobileHostMigration(prepared, window.localStorage);
  if (committed.kind === "repair") return mobileMigrationRepair("unavailable");
  return readyMobileBoot(
    committed.directory,
    activeMobileHost(committed.directory),
    withPreparedCredentials(connection, credentials),
  );
}

function mobileMigrationRepair(
  repairAction: "tailnet" | "unavailable",
): Extract<MobileBootResult, { readonly kind: "setup"; readonly mode: "repair" }> {
  return {
    kind: "setup",
    mode: "repair",
    repairAction,
    message: repairAction === "tailnet"
      ? "The saved connection cannot be opened. You can replace it with a verified Tailnet address."
      : "T4 Code cannot update saved connection storage. Close and reopen the app, then check system storage settings.",
  };
}

function projectedMobileConnection(host: MobileHost): PreparedMobileConnection {
  const preferredId = host.preferredTransportIds[0]!;
  const transport = host.transports.find((item) => item.id === preferredId)!;
  return transport.kind === "tailscale"
    ? {
        hostId: host.id,
        label: host.label,
        transportId: transport.id,
        kind: "tailscale",
        origin: transport.origin,
        wsUrl: transport.wsUrl,
        credentialScopeKey: transport.credentialScopeKey,
      }
    : {
        hostId: host.id,
        label: host.label,
        transportId: transport.id,
        kind: "hyperdht",
        invite: transport.invite,
      };
}

function validatedNativeCredentials(credentials: {
  readonly deviceId: string;
  readonly deviceToken: string;
}): { readonly deviceId: string; readonly deviceToken: string } {
  if (credentials.deviceId.length === 0 || credentials.deviceId.length > 256) {
    throw new Error("invalid device id");
  }
  return {
    deviceId: credentials.deviceId,
    deviceToken: validateDeviceToken(credentials.deviceToken, "deviceToken"),
  };
}

function withPreparedCredentials(
  connection: PreparedMobileConnection,
  credentials: { readonly deviceId: string; readonly deviceToken: string } | null,
): PreparedMobileConnection {
  if (connection.kind === "hyperdht" || credentials === null) return connection;
  return { ...connection, credentials };
}

function readyMobileBoot(
  directory: MobileHostDirectory,
  host: MobileHost,
  connection: PreparedMobileConnection,
): Extract<MobileBootResult, { readonly kind: "ready" }> {
  window.__t4PreparedMobileConnection = connection;
  delete window.__t4MobileBackend;
  delete window.__t4MobilePeerInvite;
  return { kind: "ready", host, directory, connection };
}

export async function persistNativeMobileCredentials(credentials: {
  readonly deviceId: string;
  readonly deviceToken: string;
}): Promise<void> {
  if (nativeMobilePlatform() === null) return;
  const connection = currentPreparedMobileConnection();
  if (connection === null) throw new Error("The active mobile host is unavailable");
  if (connection.kind === "hyperdht") return;
  const plugin = secureStorage();
  if (plugin === null) throw new Error("Android secure storage is unavailable");
  await plugin.setCredentials({
    hostKey: connection.credentialScopeKey,
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
  if (
    window.__t4PreparedMobileConnection?.kind === "tailscale" &&
    window.__t4PreparedMobileConnection.credentialScopeKey === origin
  ) {
    delete window.__t4PreparedMobileConnection;
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
      finish(new MobileConnectionUserError("T4 Code could not reach that host. Check Tailscale and the address."));
    const onClose = () =>
      finish(new MobileConnectionUserError("The host closed the connection before T4 Code could start."));
    const onAbort = () => {
      finish(new DOMException("The host check was cancelled.", "AbortError"));
      socket.close();
    };
    const timer = setTimeout(() => {
      socket.close();
      finish(new MobileConnectionUserError("The host did not answer. Check that Tailscale and the T4 gateway are running."));
    }, timeoutMs);
    socket.addEventListener("open", onOpen);
    socket.addEventListener("error", onError);
    socket.addEventListener("close", onClose);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
