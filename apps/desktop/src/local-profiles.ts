import { lstat, readFile, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join, normalize } from "node:path";
import { decodeLocalProfileId } from "@t4-code/protocol/desktop-ipc";

const MAX_PROFILES = 64;
const MAX_REGISTRY_BYTES = 1_048_576;

export interface LocalProfileRecord {
  readonly profileId: string;
  readonly label: string;
  readonly autoStart: boolean;
}

export interface LocalProfileRegistryState {
  readonly version: 1;
  readonly records: readonly LocalProfileRecord[];
  readonly ignoredProfileIds: readonly string[];
}

export interface LocalProfileStore {
  read(): unknown;
  write(value: LocalProfileRegistryState): Promise<void>;
}

export interface NativeProfileDiscoveryOptions {
  readonly homeDirectory?: string;
}

export const DEFAULT_LOCAL_PROFILE: LocalProfileRecord = Object.freeze({
  profileId: "default",
  label: "Default",
  autoStart: true,
});

function safeLabel(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback;
  let cleaned = "";
  for (const codePoint of value) {
    const code = codePoint.codePointAt(0) ?? 0;
    cleaned += code <= 0x1f || (code >= 0x7f && code <= 0x9f) ? " " : codePoint;
  }
  cleaned = cleaned.trim().replace(/\s+/gu, " ").slice(0, 128);
  return cleaned || fallback;
}

function derivedLabel(profileId: string): string {
  return profileId
    .split(/[._-]+/u)
    .filter(Boolean)
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join(" ") || profileId;
}

export function localTargetId(profileId: string): string {
  const id = decodeLocalProfileId(profileId);
  return id === "default" ? "local" : `local:${id}`;
}

export function decodeLocalProfileRecord(value: unknown): LocalProfileRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error("invalid local profile record");
  const item = value as Record<string, unknown>;
  for (const key of Object.keys(item))
    if (!["profileId", "label", "autoStart"].includes(key))
      throw new Error("invalid local profile record");
  const profileId = decodeLocalProfileId(item.profileId);
  if (
    typeof item.label !== "string" ||
    item.label.length === 0 ||
    safeLabel(item.label, "") !== item.label
  )
    throw new Error("invalid local profile label");
  if (typeof item.autoStart !== "boolean") throw new Error("invalid local profile autoStart");
  if (profileId === "default") return DEFAULT_LOCAL_PROFILE;
  return Object.freeze({ profileId, label: item.label, autoStart: item.autoStart });
}

export function decodeLocalProfileState(value: unknown): LocalProfileRegistryState {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error("invalid local profile state");
  const item = value as Record<string, unknown>;
  if (
    item.version !== 1 ||
    !Array.isArray(item.records) ||
    !Array.isArray(item.ignoredProfileIds) ||
    item.records.length > MAX_PROFILES ||
    item.ignoredProfileIds.length > MAX_PROFILES
  )
    throw new Error("invalid local profile state");
  const records = item.records.map(decodeLocalProfileRecord);
  const seen = new Set<string>();
  const deduped: LocalProfileRecord[] = [DEFAULT_LOCAL_PROFILE];
  seen.add("default");
  for (const record of records) {
    if (seen.has(record.profileId)) continue;
    seen.add(record.profileId);
    deduped.push(record);
  }
  const ignored = item.ignoredProfileIds.map(decodeLocalProfileId).filter((id) => id !== "default");
  return Object.freeze({
    version: 1,
    records: Object.freeze(deduped),
    ignoredProfileIds: Object.freeze([...new Set(ignored)]),
  });
}

function emptyState(): LocalProfileRegistryState {
  return { version: 1, records: [DEFAULT_LOCAL_PROFILE], ignoredProfileIds: [] };
}

async function regularFile(path: string): Promise<boolean> {
  try {
    const stat = await lstat(path);
    return stat.isFile() && !stat.isSymbolicLink() && stat.size <= MAX_REGISTRY_BYTES;
  } catch {
    return false;
  }
}

async function nativeAgentDirectory(path: string): Promise<boolean> {
  try {
    const agent = await lstat(path);
    if (!agent.isDirectory() || agent.isSymbolicLink()) return false;
    return regularFile(join(path, "config.yml"));
  } catch {
    return false;
  }
}

/** Discover only OMP's native default/named layout. Arbitrary PI_CONFIG_DIR roots are excluded. */
export async function discoverNativeOmpProfiles(
  options: NativeProfileDiscoveryOptions = {},
): Promise<readonly LocalProfileRecord[]> {
  const home = options.homeDirectory ?? homedir();
  const ompRoot = join(home, ".omp");
  const namedRoot = join(ompRoot, "profiles");
  const discovered = new Map<string, LocalProfileRecord>();
  discovered.set("default", DEFAULT_LOCAL_PROFILE);

  const registryPath = join(ompRoot, "home", "profiles.json");
  if (await regularFile(registryPath)) {
    try {
      const parsed = JSON.parse(await readFile(registryPath, "utf8")) as unknown;
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
        const root = parsed as { version?: unknown; profiles?: unknown };
        if (root.version === 1 && Array.isArray(root.profiles)) {
          for (const value of root.profiles.slice(0, MAX_PROFILES)) {
            if (value === null || typeof value !== "object" || Array.isArray(value)) continue;
            const entry = value as { id?: unknown; label?: unknown; agentDir?: unknown };
            let profileId: string;
            try {
              profileId = decodeLocalProfileId(entry.id);
            } catch {
              continue;
            }
            const expectedAgentDir = profileId === "default"
              ? join(ompRoot, "agent")
              : join(namedRoot, profileId, "agent");
            if (
              typeof entry.agentDir !== "string" ||
              normalize(entry.agentDir) !== normalize(expectedAgentDir) ||
              !(await nativeAgentDirectory(expectedAgentDir))
            )
              continue;
            discovered.set(profileId, Object.freeze({
              profileId,
              label: profileId === "default"
                ? DEFAULT_LOCAL_PROFILE.label
                : safeLabel(entry.label, derivedLabel(profileId)),
              autoStart: profileId === "default",
            }));
          }
        }
      }
    } catch {
      // A malformed OMP Home registry does not suppress directory discovery.
    }
  }

  try {
    for (const entry of (await readdir(namedRoot, { withFileTypes: true })).slice(0, MAX_PROFILES)) {
      if (!entry.isDirectory()) continue;
      let profileId: string;
      try {
        profileId = decodeLocalProfileId(entry.name);
      } catch {
        continue;
      }
      if (profileId === "default") continue;
      const agentDir = join(namedRoot, profileId, "agent");
      if (!(await nativeAgentDirectory(agentDir))) continue;
      if (!discovered.has(profileId))
        discovered.set(profileId, Object.freeze({
          profileId,
          label: derivedLabel(profileId),
          autoStart: false,
        }));
    }
  } catch {
    // Native profiles are optional.
  }
  return Object.freeze([...discovered.values()]);
}

function stateEqual(left: LocalProfileRegistryState, right: LocalProfileRegistryState): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function enqueue<T>(queue: { tail: Promise<void> }, operation: () => Promise<T>): Promise<T> {
  const result = queue.tail.then(operation, operation);
  queue.tail = result.then(() => undefined, () => undefined);
  return result;
}

export class LocalProfileRegistry {
  private readonly store: LocalProfileStore;
  private readonly discover: () => Promise<readonly LocalProfileRecord[]>;
  private readonly queue = { tail: Promise.resolve() };

  constructor(
    store: LocalProfileStore,
    discover: () => Promise<readonly LocalProfileRecord[]> = () => discoverNativeOmpProfiles(),
  ) {
    this.store = store;
    this.discover = discover;
  }

  list(): Promise<readonly LocalProfileRecord[]> {
    return enqueue(this.queue, async () => (await this.readMerged()).records);
  }

  get(profileId: string): Promise<LocalProfileRecord> {
    return enqueue(this.queue, async () => {
      const id = decodeLocalProfileId(profileId);
      const record = (await this.readMerged()).records.find((value) => value.profileId === id);
      if (record === undefined) throw new Error("local profile not found");
      return record;
    });
  }

  add(input: { readonly profileId: string; readonly label?: string; readonly autoStart?: boolean }): Promise<LocalProfileRecord> {
    return enqueue(this.queue, async () => {
      const profileId = decodeLocalProfileId(input.profileId);
      if (profileId === "default") throw new Error("default profile is immutable");
      const state = await this.readMerged();
      if (state.records.some((record) => record.profileId === profileId))
        throw new Error("local profile already exists");
      if (state.records.length >= MAX_PROFILES) throw new Error("local profile limit reached");
      const record: LocalProfileRecord = Object.freeze({
        profileId,
        label: safeLabel(input.label, derivedLabel(profileId)),
        autoStart: input.autoStart ?? false,
      });
      await this.store.write({
        version: 1,
        records: [...state.records, record],
        ignoredProfileIds: state.ignoredProfileIds.filter((id) => id !== profileId),
      });
      return record;
    });
  }

  update(
    profileId: string,
    changes: { readonly label?: string; readonly autoStart?: boolean },
  ): Promise<LocalProfileRecord> {
    return enqueue(this.queue, async () => {
      const id = decodeLocalProfileId(profileId);
      if (id === "default") throw new Error("default profile is immutable");
      const state = await this.readMerged();
      const current = state.records.find((record) => record.profileId === id);
      if (current === undefined) throw new Error("local profile not found");
      const updated: LocalProfileRecord = Object.freeze({
        profileId: id,
        label: changes.label === undefined ? current.label : safeLabel(changes.label, current.label),
        autoStart: changes.autoStart ?? current.autoStart,
      });
      await this.store.write({
        ...state,
        records: state.records.map((record) => record.profileId === id ? updated : record),
      });
      return updated;
    });
  }

  remove(profileId: string): Promise<void> {
    return enqueue(this.queue, async () => {
      const id = decodeLocalProfileId(profileId);
      if (id === "default") throw new Error("default profile is immutable");
      const state = await this.readMerged();
      if (!state.records.some((record) => record.profileId === id))
        throw new Error("local profile not found");
      await this.store.write({
        version: 1,
        records: state.records.filter((record) => record.profileId !== id),
        ignoredProfileIds: [...new Set([...state.ignoredProfileIds, id])],
      });
    });
  }

  private state(): LocalProfileRegistryState {
    try {
      return decodeLocalProfileState(this.store.read());
    } catch {
      return emptyState();
    }
  }

  private async readMerged(): Promise<LocalProfileRegistryState> {
    const current = this.state();
    let discovered: readonly LocalProfileRecord[] = [];
    try {
      discovered = await this.discover();
    } catch {
      // Persistent user records remain usable if discovery fails.
    }
    const records = [...current.records];
    const seen = new Set(records.map((record) => record.profileId));
    const ignored = new Set(current.ignoredProfileIds);
    for (const candidate of discovered) {
      let record: LocalProfileRecord;
      try {
        record = decodeLocalProfileRecord(candidate);
      } catch {
        continue;
      }
      if (record.profileId === "default" || seen.has(record.profileId) || ignored.has(record.profileId))
        continue;
      if (records.length >= MAX_PROFILES) break;
      records.push({ ...record, autoStart: false });
      seen.add(record.profileId);
    }
    const merged = decodeLocalProfileState({
      version: 1,
      records,
      ignoredProfileIds: current.ignoredProfileIds,
    });
    if (!stateEqual(current, merged)) await this.store.write(merged);
    return merged;
  }
}
