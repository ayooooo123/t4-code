import { randomBytes } from "node:crypto";
import { hostname } from "node:os";
import ElectronStore from "electron-store";
import { safeStorage } from "electron";
import type { CursorRecord, CursorStore } from "@t4-code/client";
import type { CredentialEntry, CredentialVault, PairedHostRecord, TargetRegistry } from "@t4-code/remote";
import type { CredentialCiphertextStore, RemoteTargetRecord, RemoteTargetStore, SafeStorageAdapter } from "./remote-runtime/index.ts";
import type { PeerPairingMaterial, PeerPairingStore } from "./peer-share.ts";
import type { WorkspaceRootsRecord, WorkspaceRootsStore } from "./workspace-roots.ts";
import {
  DEFAULT_LOCAL_PROFILE,
  decodeLocalProfileState,
  type LocalProfileRegistryState,
  type LocalProfileStore,
} from "./local-profiles.ts";

export interface DeviceIdentity {
  readonly deviceId: string;
  readonly deviceName: string;
}
interface CursorState { readonly cursors: Record<string, CursorRecord>; }
interface RegistryState { readonly targets: Record<string, PairedHostRecord>; }
interface VaultState { readonly ciphertext: Record<string, string>; }
interface RemoteRegistryState { readonly version: 1; readonly records: readonly RemoteTargetRecord[]; }
interface CredentialCiphertextState { readonly version: 1; readonly ciphertexts: Record<string, string>; }
interface PeerPairingCiphertextState { readonly version: 1; readonly ciphertext?: string; }
interface WorkspaceRootsState { readonly record?: WorkspaceRootsRecord; }

function recordKey(hostId: string, sessionId: string): string { return `${hostId}\u0000${sessionId}`; }
function decodeRemoteState(value: unknown): RemoteRegistryState {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid remote target state");
  const root = value as { version?: unknown; records?: unknown };
  if (root.version !== 1 || !Array.isArray(root.records) || root.records.some((record) => !record || typeof record !== "object" || Array.isArray(record))) throw new Error("invalid remote target state");
  return { version: 1, records: [...root.records] as RemoteTargetRecord[] };
}
function decodeCredentialState(value: unknown): CredentialCiphertextState {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid credential state");
  const root = value as { version?: unknown; ciphertexts?: unknown };
  if (root.version !== 1 || !root.ciphertexts || typeof root.ciphertexts !== "object" || Array.isArray(root.ciphertexts)) throw new Error("invalid credential state");
  const ciphertexts: Record<string, string> = {};
  for (const [key, encoded] of Object.entries(root.ciphertexts)) {
    if (typeof encoded !== "string" || encoded.length > 16_384 || !/^[A-Za-z0-9+/]*={0,2}$/u.test(encoded) || Buffer.from(encoded, "base64").toString("base64") !== encoded) throw new Error("invalid credential state");
    ciphertexts[key] = encoded;
  }
  return { version: 1, ciphertexts };
}
function decodePeerPairingCiphertextState(value: unknown): PeerPairingCiphertextState {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid peer pairing store");
  const root = value as { version?: unknown; ciphertext?: unknown };
  if (root.version !== 1 || root.ciphertext !== undefined && (typeof root.ciphertext !== "string" || root.ciphertext.length > 16_384 || !/^[A-Za-z0-9+/]*={0,2}$/u.test(root.ciphertext) || Buffer.from(root.ciphertext, "base64").toString("base64") !== root.ciphertext)) throw new Error("invalid peer pairing store");
  return root.ciphertext === undefined ? { version: 1 } : { version: 1, ciphertext: root.ciphertext };
}
function pairingBytes(value: unknown, expected: number): Uint8Array {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/u.test(value)) throw new Error("invalid peer pairing");
  const decoded = Buffer.from(value, "base64url");
  if (decoded.byteLength !== expected || decoded.toString("base64url") !== value) throw new Error("invalid peer pairing");
  return new Uint8Array(decoded);
}
function enqueueWrite(queue: { tail: Promise<void> }, operation: () => void): Promise<void> {
  const result = queue.tail.then(operation, operation);
  queue.tail = result.then(() => undefined, () => undefined);
  return result;
}

export class ElectronCursorStore implements CursorStore {
  private readonly store: ElectronStore<CursorState>;
  constructor(store = new ElectronStore<CursorState>({ name: "cursor-state", defaults: { cursors: {} } })) { this.store = store; }
  load(): CursorRecord[] { return Object.values(this.store.get("cursors")); }
  save(record: CursorRecord): void {
    const cursors = this.store.get("cursors");
    this.store.set("cursors", { ...cursors, [recordKey(record.hostId, record.sessionId)]: record });
  }
}

export class ElectronTargetRegistry implements TargetRegistry {
  private readonly store: ElectronStore<RegistryState>;
  constructor(store = new ElectronStore<RegistryState>({ name: "target-registry", defaults: { targets: {} } })) { this.store = store; }
  async get(targetId: string): Promise<PairedHostRecord | null> { return this.store.get("targets")[targetId] ?? null; }
  async put(record: PairedHostRecord): Promise<void> { this.store.set("targets", { ...this.store.get("targets"), [record.targetId]: record }); }
  async delete(targetId: string): Promise<void> {
    const targets = { ...this.store.get("targets") };
    delete targets[targetId];
    this.store.set("targets", targets);
  }
}

export class EncryptedCredentialVault implements CredentialVault {
  private readonly store: ElectronStore<VaultState>;
  constructor(store = new ElectronStore<VaultState>({ name: "credential-vault", defaults: { ciphertext: {} } })) {
    if (!safeStorage.isEncryptionAvailable()) throw new Error("encrypted credential storage is unavailable");
    if (process.platform === "linux" && safeStorage.getSelectedStorageBackend() === "basic_text") throw new Error("encrypted credential storage backend is unsafe");
    this.store = store;
  }
  async get(credentialRef: string): Promise<CredentialEntry | null> {
    const encoded = this.store.get("ciphertext")[credentialRef];
    if (encoded === undefined) return null;
    let value: unknown;
    try { value = JSON.parse(safeStorage.decryptString(Buffer.from(encoded, "base64"))) as unknown; } catch { throw new Error("encrypted credential could not be decrypted"); }
    if (!value || typeof value !== "object") throw new Error("encrypted credential is invalid");
    const entry = value as { token?: unknown; expiresAt?: unknown };
    if (typeof entry.token !== "string" || typeof entry.expiresAt !== "string" && typeof entry.expiresAt !== "number") throw new Error("encrypted credential is invalid");
    const expiry = typeof entry.expiresAt === "number" ? entry.expiresAt : Date.parse(entry.expiresAt);
    if (!Number.isFinite(expiry) || expiry <= Date.now()) { await this.delete(credentialRef); return null; }
    return { token: entry.token, expiresAt: entry.expiresAt };
  }
  async set(credentialRef: string, credential: string | CredentialEntry): Promise<void> {
    if (typeof credential === "string") throw new Error("credential expiry is required");
    const expiry = typeof credential.expiresAt === "number" ? credential.expiresAt : Date.parse(credential.expiresAt);
    if (!Number.isFinite(expiry) || expiry <= Date.now() || credential.token.length === 0) throw new Error("credential expiry is invalid");
    const cleartext = JSON.stringify({ token: credential.token, expiresAt: credential.expiresAt });
    const encrypted = safeStorage.encryptString(cleartext).toString("base64");
    this.store.set("ciphertext", { ...this.store.get("ciphertext"), [credentialRef]: encrypted });
  }
  async delete(credentialRef: string): Promise<void> {
    const values = { ...this.store.get("ciphertext") };
    delete values[credentialRef];
    this.store.set("ciphertext", values);
  }
}

export class ElectronRemoteTargetStore implements RemoteTargetStore {
  private readonly store: ElectronStore<RemoteRegistryState>;
  private readonly writeQueue = { tail: Promise.resolve() };
  constructor(store = new ElectronStore<RemoteRegistryState>({ name: "remote-target-registry", defaults: { version: 1, records: [] } })) { this.store = store; }
  read(): RemoteRegistryState { return decodeRemoteState(this.store.store); }
  write(value: unknown): Promise<void> {
    return enqueueWrite(this.writeQueue, () => {
      const state = decodeRemoteState(value);
      this.store.set("version", state.version);
      this.store.set("records", state.records);
    });
  }
}

export class ElectronCredentialCiphertextStore implements CredentialCiphertextStore {
  private readonly store: ElectronStore<CredentialCiphertextState>;
  private readonly writeQueue = { tail: Promise.resolve() };
  constructor(store = new ElectronStore<CredentialCiphertextState>({ name: "device-credentials", defaults: { version: 1, ciphertexts: {} } })) { this.store = store; }
  read(): CredentialCiphertextState { return decodeCredentialState(this.store.store); }
  write(value: unknown): Promise<void> {
    return enqueueWrite(this.writeQueue, () => {
      const state = decodeCredentialState(value);
      this.store.set("version", state.version);
      this.store.set("ciphertexts", state.ciphertexts);
    });
  }
}

export interface PeerPairingCiphertextStore {
  read(): unknown;
  write(value: unknown): Promise<void>;
}

export class ElectronPeerPairingCiphertextStore implements PeerPairingCiphertextStore {
  private readonly store: ElectronStore<PeerPairingCiphertextState>;
  private readonly writeQueue = { tail: Promise.resolve() };
  constructor(store = new ElectronStore<PeerPairingCiphertextState>({ name: "peer-pairing", defaults: { version: 1 } })) { this.store = store; }
  read(): PeerPairingCiphertextState { return decodePeerPairingCiphertextState(this.store.store); }
  write(value: unknown): Promise<void> {
    return enqueueWrite(this.writeQueue, () => {
      const state = decodePeerPairingCiphertextState(value);
      this.store.set("version", state.version);
      if (state.ciphertext === undefined) this.store.delete("ciphertext");
      else this.store.set("ciphertext", state.ciphertext);
    });
  }
}

export class ElectronPeerPairingStore implements PeerPairingStore {
  private readonly store: PeerPairingCiphertextStore;
  private readonly encryption: SafeStorageAdapter;
  constructor(store: PeerPairingCiphertextStore = new ElectronPeerPairingCiphertextStore(), encryption: SafeStorageAdapter = electronSafeStorage) {
    if (!encryption.isEncryptionAvailable() || encryption.selectedStorageBackend?.() === "basic_text") throw new Error("encrypted peer pairing storage unavailable");
    this.store = store;
    this.encryption = encryption;
  }
  async load(): Promise<PeerPairingMaterial | null> {
    const state = decodePeerPairingCiphertextState(this.store.read());
    if (state.ciphertext === undefined) return null;
    let value: unknown;
    try { value = JSON.parse(this.encryption.decryptString(Buffer.from(state.ciphertext, "base64"))) as unknown; } catch { throw new Error("invalid peer pairing"); }
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid peer pairing");
    const pairing = value as { version?: unknown; publicKey?: unknown; secretKey?: unknown; capability?: unknown };
    if (pairing.version !== 1) throw new Error("invalid peer pairing");
    return {
      publicKey: pairingBytes(pairing.publicKey, 32),
      secretKey: pairingBytes(pairing.secretKey, 64),
      capability: pairingBytes(pairing.capability, 32),
    };
  }
  async save(value: PeerPairingMaterial): Promise<void> {
    const publicKey = pairingBytes(Buffer.from(value.publicKey).toString("base64url"), 32);
    const secretKey = pairingBytes(Buffer.from(value.secretKey).toString("base64url"), 64);
    const capability = pairingBytes(Buffer.from(value.capability).toString("base64url"), 32);
    const cleartext = JSON.stringify({
      version: 1,
      publicKey: Buffer.from(publicKey).toString("base64url"),
      secretKey: Buffer.from(secretKey).toString("base64url"),
      capability: Buffer.from(capability).toString("base64url"),
    });
    await this.store.write({ version: 1, ciphertext: this.encryption.encryptString(cleartext).toString("base64") });
  }
}

/** Host-local workspace configuration. Paths never leave the desktop process unvalidated. */
export class ElectronWorkspaceRootsStore implements WorkspaceRootsStore {
  private readonly store: ElectronStore<WorkspaceRootsState>;
  constructor(store = new ElectronStore<WorkspaceRootsState>({ name: "workspace-roots", defaults: {} })) { this.store = store; }
  async load(): Promise<unknown> { return this.store.get("record") ?? null; }
  async save(value: WorkspaceRootsRecord): Promise<void> { this.store.set("record", value); }
}
export class ElectronLocalProfileStore implements LocalProfileStore {
  private readonly store: ElectronStore<LocalProfileRegistryState>;
  private readonly writeQueue = { tail: Promise.resolve() };
  constructor(
    store = new ElectronStore<LocalProfileRegistryState>({
      name: "local-profile-registry",
      defaults: {
        version: 1,
        records: [DEFAULT_LOCAL_PROFILE],
        ignoredProfileIds: [],
      },
    }),
  ) {
    this.store = store;
  }
  read(): unknown { return this.store.store; }
  write(value: LocalProfileRegistryState): Promise<void> {
    return enqueueWrite(this.writeQueue, () => {
      const state = decodeLocalProfileState(value);
      this.store.set("version", state.version);
      this.store.set("records", state.records);
      this.store.set("ignoredProfileIds", state.ignoredProfileIds);
    });
  }
}
export const electronSafeStorage: SafeStorageAdapter = {
  isEncryptionAvailable: () => {
    try {
      if (!safeStorage.isEncryptionAvailable()) return false;
      return process.platform !== "linux" || safeStorage.getSelectedStorageBackend() !== "basic_text";
    } catch { return false; }
  },
  selectedStorageBackend: () => { try { return safeStorage.getSelectedStorageBackend(); } catch { return "unknown"; } },
  encryptString: (value) => { if (!electronSafeStorage.isEncryptionAvailable()) throw new Error("encrypted credential storage unavailable"); return safeStorage.encryptString(value); },
  decryptString: (value) => { if (!electronSafeStorage.isEncryptionAvailable()) throw new Error("encrypted credential storage unavailable"); return safeStorage.decryptString(value); },
};

const identityId = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
function hasControlCodePoint(value: string): boolean {
  for (const codePoint of value) {
    const code = codePoint.codePointAt(0) ?? 0;
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) return true;
  }
  return false;
}
function boundedDeviceName(value: string): string {
  let cleaned = "";
  for (const codePoint of value) cleaned += hasControlCodePoint(codePoint) ? " " : codePoint;
  cleaned = cleaned.trim().replace(/\s+/gu, " ").slice(0, 64);
  return cleaned || "T4 Code Desktop";
}
export function loadDeviceIdentity(store = new ElectronStore<{ deviceId?: string; deviceName?: string }>({ name: "device-identity", defaults: {} })): DeviceIdentity {
  const existing = store.get("deviceId");
  const deviceId = typeof existing === "string" && identityId.test(existing) ? existing : randomBytes(24).toString("base64url");
  if (existing !== deviceId) store.set("deviceId", deviceId);
  const existingName = store.get("deviceName");
  const deviceName = boundedDeviceName(typeof existingName === "string" && existingName.length > 0 ? existingName : hostname());
  if (existingName !== deviceName) store.set("deviceName", deviceName);
  return { deviceId, deviceName };
}
