import {
  MOBILE_HOST_DIRECTORY_STORAGE_KEY,
  StoredMobileDirectoryError,
  parseMobileHostDirectory,
  type MobileHost,
  type MobileHostDirectory,
} from "./mobile-host-schema.ts";
import {
  parsePeerBackend,
  parseTailnetBackend,
  peerDesktopFingerprint,
  type StoredMobileBackend,
  type StoredPeerMobileBackend,
} from "./mobile-connection-records.ts";

const MAX_SAVED_MOBILE_BACKENDS = 16;
const MIGRATION_REPAIR_MESSAGE = "The saved mobile connection needs to be repaired before it can be migrated.";
const MOBILE_HOST_ID_PATTERN = /^[A-Za-z0-9_-]{16,64}$/u;
const LEGACY_MOBILE_BACKEND_STORAGE_KEY = "t4-code:mobile-backend:v1";
const MOBILE_BACKEND_STORAGE_KEY = "t4-code:mobile-backends:v2";

export interface StoredMobileBackendDirectory {
  readonly version: 2;
  readonly activeOrigin: string;
  readonly backends: readonly StoredMobileBackend[];
}

export type StoredV2MobileConnection =
  | { readonly kind: "tailscale"; readonly directory: StoredMobileBackendDirectory }
  | { readonly kind: "hyperdht"; readonly backend: StoredPeerMobileBackend };

export type MobileHostMigrationIdKind = "host" | "tailscale" | "hyperdht";

export type MobileHostMigration =
  | { readonly kind: "empty" }
  | { readonly kind: "candidate"; readonly directory: MobileHostDirectory }
  | { readonly kind: "repair"; readonly message: string };

export interface PendingMobileHostMigration {
  readonly kind: "pending";
  readonly directory: MobileHostDirectory;
  readonly legacyOrigin?: string;
}

export type PreparedMobileHostDirectoryLoad =
  | { readonly kind: "existing"; readonly directory: MobileHostDirectory }
  | { readonly kind: "empty" }
  | PendingMobileHostMigration
  | { readonly kind: "repair"; readonly message: string };

export type CommittedMobileHostMigration =
  | { readonly kind: "ready"; readonly directory: MobileHostDirectory }
  | { readonly kind: "repair"; readonly message: string };

interface PendingMobileHostMigrationSnapshot {
  readonly v2Raw: string | null;
  readonly legacyRaw: string | null;
  readonly candidateRaw: string;
  readonly directory: MobileHostDirectory;
  readonly legacyOrigin: string | null;
}

const pendingMobileHostMigrationSnapshots = new WeakMap<
  PendingMobileHostMigration,
  PendingMobileHostMigrationSnapshot
>();

function storageError(action: "read" | "written"): StoredMobileDirectoryError {
  return new StoredMobileDirectoryError(`The saved mobile host directory could not be ${action}.`);
}

function invalidSource(): never {
  throw new StoredMobileDirectoryError(MIGRATION_REPAIR_MESSAGE);
}

function parseRawSource(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return invalidSource();
  }
}

export function decodeStoredMobileBackend(value: unknown): StoredMobileBackend {
  if (value === null || typeof value !== "object" || Array.isArray(value)) invalidSource();
  const data = value as Record<string, unknown>;
  if (data.version !== 1 || typeof data.origin !== "string") invalidSource();
  try {
    const canonical = parseTailnetBackend(data.origin);
    if (data.wsUrl !== canonical.wsUrl || data.label !== canonical.label) invalidSource();
    return canonical;
  } catch {
    return invalidSource();
  }
}

export function decodeStoredPeerMobileBackend(value: unknown): StoredPeerMobileBackend | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const data = value as Record<string, unknown>;
  if (data.version !== 2 || data.kind !== "peer" || typeof data.invite !== "string") return null;
  try {
    const canonical = parsePeerBackend(data.invite);
    if (data.label !== canonical.label) invalidSource();
    return canonical;
  } catch {
    return invalidSource();
  }
}

export function decodeStoredMobileBackendDirectory(value: unknown): StoredMobileBackendDirectory {
  if (value === null || typeof value !== "object" || Array.isArray(value)) invalidSource();
  const data = value as Record<string, unknown>;
  if (
    data.version !== 2 ||
    typeof data.activeOrigin !== "string" ||
    !Array.isArray(data.backends) ||
    data.backends.length === 0 ||
    data.backends.length > MAX_SAVED_MOBILE_BACKENDS
  ) {
    invalidSource();
  }
  const backends = data.backends.map(decodeStoredMobileBackend);
  const origins = new Set(backends.map((backend) => backend.origin));
  if (origins.size !== backends.length || !origins.has(data.activeOrigin)) invalidSource();
  return { version: 2, activeOrigin: data.activeOrigin, backends };
}

export function decodeStoredV2MobileConnection(raw: string): StoredV2MobileConnection {
  const value = parseRawSource(raw);
  const peer = decodeStoredPeerMobileBackend(value);
  return peer === null
    ? { kind: "tailscale", directory: decodeStoredMobileBackendDirectory(value) }
    : { kind: "hyperdht", backend: peer };
}

export function decodeStoredLegacyMobileBackend(raw: string): StoredMobileBackend {
  return decodeStoredMobileBackend(parseRawSource(raw));
}

function tailscaleHost(backend: StoredMobileBackend, hostId: string, transportId: string): MobileHost {
  return {
    id: hostId,
    label: backend.label,
    transports: [{
      id: transportId,
      kind: "tailscale",
      origin: backend.origin,
      wsUrl: backend.wsUrl,
      displayAddress: backend.origin,
      credentialScopeKey: backend.origin,
    }],
    preferredTransportIds: [transportId],
    lastConnection: null,
  };
}

function peerHost(backend: StoredPeerMobileBackend, hostId: string, transportId: string): MobileHost {
  return {
    id: hostId,
    label: backend.label,
    transports: [{
      id: transportId,
      kind: "hyperdht",
      invite: backend.invite,
      desktopFingerprint: peerDesktopFingerprint(backend.invite),
    }],
    preferredTransportIds: [transportId],
    lastConnection: null,
  };
}

export function buildMobileHostMigration(
  sources: { readonly legacyRaw: string | null; readonly v2Raw: string | null },
  nextId: (kind: MobileHostMigrationIdKind) => string,
): MobileHostMigration {
  if (sources.legacyRaw === null && sources.v2Raw === null) return { kind: "empty" };
  try {
    const legacy = sources.legacyRaw === null
      ? null
      : decodeStoredLegacyMobileBackend(sources.legacyRaw);
    const v2 = sources.v2Raw === null ? null : decodeStoredV2MobileConnection(sources.v2Raw);
    const hosts: MobileHost[] = [];
    const generatedIds = new Set<string>();
    const generatedId = (kind: MobileHostMigrationIdKind): string => {
      const value = nextId(kind);
      if (!MOBILE_HOST_ID_PATTERN.test(value) || generatedIds.has(value)) invalidSource();
      generatedIds.add(value);
      return value;
    };
    let activeHostId = "";
    const addTailnet = (backend: StoredMobileBackend, active: boolean): void => {
      const hostId = generatedId("host");
      const transportId = generatedId("tailscale");
      hosts.push(tailscaleHost(backend, hostId, transportId));
      if (active) activeHostId = hostId;
    };
    if (v2?.kind === "tailscale") {
      for (const backend of v2.directory.backends) {
        addTailnet(backend, backend.origin === v2.directory.activeOrigin);
      }
    } else if (v2?.kind === "hyperdht") {
      const hostId = generatedId("host");
      const transportId = generatedId("hyperdht");
      hosts.push(peerHost(v2.backend, hostId, transportId));
      activeHostId = hostId;
    }
    const legacyIsDuplicate = legacy !== null && v2?.kind === "tailscale" &&
      v2.directory.backends.some((backend) => backend.origin === legacy.origin);
    if (legacy !== null && !legacyIsDuplicate) addTailnet(legacy, v2 === null);
    return {
      kind: "candidate",
      directory: parseMobileHostDirectory({ version: 3, activeHostId, hosts }),
    };
  } catch {
    return { kind: "repair", message: MIGRATION_REPAIR_MESSAGE };
  }
}

function migrationRepair(): PreparedMobileHostDirectoryLoad {
  return Object.freeze({ kind: "repair", message: MIGRATION_REPAIR_MESSAGE });
}

/**
 * Reads the current metadata generations and prepares, but never commits, a v3
 * migration. Exact source and candidate bytes are owned by this module so they
 * cannot be projected through boot results, logs, or JSON serialization.
 */
export function prepareMobileHostDirectoryLoad(
  storage: Pick<Storage, "getItem">,
  nextId: (kind: MobileHostMigrationIdKind) => string,
): PreparedMobileHostDirectoryLoad {
  let v3Raw: string | null;
  try {
    v3Raw = storage.getItem(MOBILE_HOST_DIRECTORY_STORAGE_KEY);
  } catch {
    return migrationRepair();
  }

  if (v3Raw !== null) {
    try {
      const directory = parseMobileHostDirectory(JSON.parse(v3Raw));
      return Object.freeze({ kind: "existing", directory });
    } catch {
      return migrationRepair();
    }
  }

  let v2Raw: string | null;
  let legacyRaw: string | null;
  try {
    v2Raw = storage.getItem(MOBILE_BACKEND_STORAGE_KEY);
    legacyRaw = storage.getItem(LEGACY_MOBILE_BACKEND_STORAGE_KEY);
  } catch {
    return migrationRepair();
  }

  const migration = buildMobileHostMigration({ v2Raw, legacyRaw }, nextId);
  if (migration.kind === "empty") return Object.freeze({ kind: "empty" });
  if (migration.kind === "repair") return migrationRepair();

  let legacyOrigin: string | null = null;
  if (legacyRaw !== null) {
    try {
      legacyOrigin = decodeStoredLegacyMobileBackend(legacyRaw).origin;
    } catch {
      return migrationRepair();
    }
  }

  const snapshot: PendingMobileHostMigrationSnapshot = {
    v2Raw,
    legacyRaw,
    candidateRaw: JSON.stringify(migration.directory),
    directory: migration.directory,
    legacyOrigin,
  };
  const pending: PendingMobileHostMigration = Object.freeze({
    kind: "pending",
    directory: migration.directory,
    ...(legacyOrigin === null ? {} : { legacyOrigin }),
  });
  pendingMobileHostMigrationSnapshots.set(pending, snapshot);
  return pending;
}

function commitRepair(): CommittedMobileHostMigration {
  return Object.freeze({ kind: "repair", message: MIGRATION_REPAIR_MESSAGE });
}

/**
 * Commits a preparation only while every source still has its observed bytes.
 * The exact candidate is read back before its source generations are removed.
 */
export function commitPreparedMobileHostMigration(
  pending: PendingMobileHostMigration,
  storage: Pick<Storage, "getItem" | "setItem" | "removeItem">,
): CommittedMobileHostMigration {
  const snapshot = pendingMobileHostMigrationSnapshots.get(pending);
  if (snapshot === undefined) return commitRepair();

  try {
    const currentV3 = storage.getItem(MOBILE_HOST_DIRECTORY_STORAGE_KEY);
    const currentV2 = storage.getItem(MOBILE_BACKEND_STORAGE_KEY);
    const currentLegacy = storage.getItem(LEGACY_MOBILE_BACKEND_STORAGE_KEY);
    if (
      currentV3 !== null ||
      currentV2 !== snapshot.v2Raw ||
      currentLegacy !== snapshot.legacyRaw
    ) {
      return commitRepair();
    }
  } catch {
    return commitRepair();
  }

  let verified = false;
  try {
    storage.setItem(MOBILE_HOST_DIRECTORY_STORAGE_KEY, snapshot.candidateRaw);
    const written = storage.getItem(MOBILE_HOST_DIRECTORY_STORAGE_KEY);
    if (written === snapshot.candidateRaw) {
      parseMobileHostDirectory(JSON.parse(written));
      verified = true;
    }
  } catch {
    verified = false;
  }

  if (!verified) {
    try {
      if (storage.getItem(MOBILE_HOST_DIRECTORY_STORAGE_KEY) === snapshot.candidateRaw) {
        storage.removeItem(MOBILE_HOST_DIRECTORY_STORAGE_KEY);
      }
    } catch {
      // Preserve retryable source generations. Cleanup is strictly best effort.
    }
    return commitRepair();
  }

  try { storage.removeItem(MOBILE_BACKEND_STORAGE_KEY); } catch { /* v3 is authoritative */ }
  try { storage.removeItem(LEGACY_MOBILE_BACKEND_STORAGE_KEY); } catch { /* v3 is authoritative */ }
  return Object.freeze({ kind: "ready", directory: snapshot.directory });
}

export function readMobileHostDirectory(
  storage?: Pick<Storage, "getItem">,
): MobileHostDirectory | null {
  try {
    const resolvedStorage = storage ?? window.localStorage;
    const raw = resolvedStorage.getItem(MOBILE_HOST_DIRECTORY_STORAGE_KEY);
    if (raw === null) return null;
    return parseMobileHostDirectory(JSON.parse(raw));
  } catch {
    throw storageError("read");
  }
}

export function writeMobileHostDirectory(
  directory: MobileHostDirectory,
  storage?: Pick<Storage, "setItem">,
): void {
  try {
    const canonical = parseMobileHostDirectory(directory);
    const serialized = JSON.stringify(canonical);
    const resolvedStorage = storage ?? window.localStorage;
    resolvedStorage.setItem(MOBILE_HOST_DIRECTORY_STORAGE_KEY, serialized);
  } catch {
    throw storageError("written");
  }
}
