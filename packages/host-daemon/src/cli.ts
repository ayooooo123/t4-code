#!/usr/bin/env bun
import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import {
  createAppserver,
  createRemoteAppserver,
  OfficialOmpProfileAuthority,
  OmpAuthorityBridgeClient,
  profileSocketPath,
  ProjectFileSearchAuthority,
  TranscriptSearchIndex,
  type AppserverHandle,
  type AppserverOptions,
  type OmpAuthorityBridgeInvocation,
  type RpcChildInvocation,
  type DesktopOperationsAuthority,
  type SessionAuthority,
  type SessionDiscovery,
} from "@t4-code/host-service";
import { COMMAND_DESCRIPTORS, isSecretLikeKey, type ProjectId, type SessionId } from "@t4-code/protocol";

export const T4_HOST_VERSION = "0.1.32";
export const OFFICIAL_OMP_VERSION = "17.0.9";
export const OFFICIAL_OMP_BUILD = "639bac596d94b5993349f3f6696176cb2bf9b5d3";
const PROFILE = /^[a-z0-9][a-z0-9._-]{0,63}$/u;
const ORIGIN_LIMIT = 32;
// After the bridge dies we ask the appserver to stop, but a dead bridge can wedge that teardown; cap
// the wait so the process always exits and the service manager restarts a healthy host.
const SHUTDOWN_GRACE_MS = 2_000;
const VERSION_OUTPUT_BYTES = 4 * 1024;
const VERSION_TIMEOUT_MS = 5_000;
const MODEL_CATALOG_OUTPUT_BYTES = 2 * 1024 * 1024;
const MODEL_CATALOG_TIMEOUT_MS = 10_000;
const SETTINGS_CATALOG_OUTPUT_BYTES = 2 * 1024 * 1024;
const SETTINGS_CATALOG_TIMEOUT_MS = 10_000;
const SETTINGS_WRITE_EDIT_LIMIT = 64;
const MAX_SETTING_PATH_BYTES = 512;
/** `boundedSettings` caps the wire map at MAX_MAP_KEYS keys. */
const SETTINGS_PUBLISH_LIMIT = 512;
const SETTINGS_CACHE_TTL_MS = 5_000;
const OFFICIAL_CATALOG_COMMANDS = Object.freeze([
  "session.create",
  "session.rename",
  "session.archive",
  "session.restore",
  "session.delete",
  "session.model.set",
  "session.thinking.set",
  "session.cancel",
  "settings.read",
  "settings.write",
  "session.close",
]);

function officialCommandCatalogItems(): Record<string, unknown>[] {
  const commands = process.platform === "darwin"
    ? ["project.reveal", ...OFFICIAL_CATALOG_COMMANDS]
    : OFFICIAL_CATALOG_COMMANDS;
  return commands.map(name => ({
    id: `cmd-${name.replaceAll(".", "-")}`,
    kind: "command",
    name,
    capabilities: [COMMAND_DESCRIPTORS[name]!.capability],
    supported: true,
  }));
}

function textField(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function officialModelCatalogItemsFromJson(value: unknown): Record<string, unknown>[] {
  const models = typeof value === "object" && value !== null && Array.isArray((value as { models?: unknown }).models)
    ? (value as { models: unknown[] }).models
    : [];
  const items: Record<string, unknown>[] = [];
  const seen = new Set<string>();
  for (const model of models) {
    if (typeof model !== "object" || model === null) continue;
    const record = model as Record<string, unknown>;
    const provider = textField(record.provider);
    const modelId = textField(record.id);
    const selector = textField(record.selector) ?? (provider !== undefined && modelId !== undefined ? `${provider}/${modelId}` : undefined);
    if (provider === undefined || modelId === undefined || selector === undefined || seen.has(selector)) continue;
    seen.add(selector);
    items.push({
      id: `model-${createHash("sha256").update(selector).digest("hex").slice(0, 16)}`,
      kind: "model",
      name: textField(record.name) ?? selector,
      supported: true,
      metadata: {
        provider,
        modelId,
        selector,
        ...(Number.isFinite(record.contextWindow) ? { contextWindow: record.contextWindow } : {}),
        ...(Array.isArray(record.thinking) ? { thinkingLevels: record.thinking.filter(item => typeof item === "string") } : {}),
        ...(Array.isArray(record.input) ? { input: record.input.filter(item => typeof item === "string") } : {}),
      },
    });
  }
  return items;
}

function officialModelCatalogItemFromSelector(selector: string): Record<string, unknown> | undefined {
  const slash = selector.indexOf("/");
  if (slash <= 0 || slash === selector.length - 1) return undefined;
  const provider = selector.slice(0, slash);
  const modelId = selector.slice(slash + 1);
  return {
    id: `model-${createHash("sha256").update(selector).digest("hex").slice(0, 16)}`,
    kind: "model",
    name: selector,
    supported: true,
    metadata: {
      provider,
      modelId,
      selector,
    },
  };
}

async function officialSessionModelCatalogItems(authority: SessionAuthority): Promise<Record<string, unknown>[]> {
  const items: Record<string, unknown>[] = [];
  const seen = new Set<string>();
  for (const session of await authority.list()) {
    const selector = textField(session.model);
    if (selector === undefined || seen.has(selector)) continue;
    const item = officialModelCatalogItemFromSelector(selector);
    if (item === undefined) continue;
    seen.add(selector);
    items.push(item);
  }
  return items;
}

function mergeOfficialModelCatalogItems(...groups: readonly (readonly Record<string, unknown>[])[]): Record<string, unknown>[] {
  const items: Record<string, unknown>[] = [];
  const seen = new Set<string>();
  for (const group of groups) {
    for (const item of group) {
      const metadata = typeof item.metadata === "object" && item.metadata !== null ? item.metadata as Record<string, unknown> : {};
      const selector = textField(metadata.selector) ??
        (textField(metadata.provider) !== undefined && textField(metadata.modelId) !== undefined
          ? `${textField(metadata.provider)}/${textField(metadata.modelId)}`
          : textField(item.name));
      if (selector !== undefined) {
        if (seen.has(selector)) continue;
        seen.add(selector);
      }
      items.push(item);
    }
  }
  return items;
}

async function runOfficialOmp(
  config: HostDaemonConfig,
  argv: readonly string[],
  maxBytes: number,
  timeoutMs: number,
  label: string,
): Promise<string> {
  const child = Bun.spawn([config.ompExecutable, ...argv], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, OMP_PROFILE: config.profileId },
  });
  const timer = setTimeout(() => child.kill(), timeoutMs);
  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      boundedProcessOutput(child.stdout, maxBytes),
      boundedProcessOutput(child.stderr, VERSION_OUTPUT_BYTES),
      child.exited,
    ]);
    if (exitCode !== 0) throw new Error(`official OMP ${label} failed (${exitCode}): ${stderr.trim()}`);
    return stdout;
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null) child.kill();
  }
}

async function officialModelCatalogItems(config: HostDaemonConfig): Promise<Record<string, unknown>[]> {
  const stdout = await runOfficialOmp(
    config,
    ["models", "--json"],
    MODEL_CATALOG_OUTPUT_BYTES,
    MODEL_CATALOG_TIMEOUT_MS,
    "model catalog",
  );
  return officialModelCatalogItemsFromJson(JSON.parse(stdout));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A value is only publishable when no nested key looks like a secret: the
 * wire decoder rejects the whole frame over one such key. */
function containsSecretLikeObjectKey(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsSecretLikeObjectKey);
  if (!isRecord(value)) return false;
  return Object.entries(value).some(([key, child]) => isSecretLikeKey(key) || containsSecretLikeObjectKey(child));
}

/** OMP publishes no enum options through `config list`, so an enum degrades to
 * free text rather than rendering as a broken picker. The runtime validates
 * the written value and rejects anything outside its own enum. */
function settingControlType(type: unknown, value: unknown): string {
  if (type === "boolean" || type === "number" || type === "string" || type === "array" || type === "record") return type;
  if (type === "enum") return "string";
  if (typeof value === "boolean") return "boolean";
  if (typeof value === "number") return "number";
  if (Array.isArray(value)) return "array";
  if (isRecord(value)) return "record";
  return "string";
}

/** The renderer only knows these section ids and caps sections hard, so every
 * path lands on a curated tab; the raw prefix survives as the group. */
const SETTING_TAB_BY_PREFIX: Readonly<Record<string, string>> = {
  advisor: "tasks",
  agent: "tasks",
  agents: "tasks",
  async: "tasks",
  auth: "providers",
  bash: "shell",
  browser: "tools",
  command: "shell",
  commands: "shell",
  context: "context",
  diff: "files",
  edit: "files",
  file: "files",
  files: "files",
  github: "tools",
  history: "memory",
  image: "tools",
  inspect_image: "tools",
  instructions: "context",
  mcp: "tools",
  memory: "memory",
  model: "model",
  models: "model",
  notification: "interaction",
  notifications: "interaction",
  prelude: "context",
  project: "files",
  prompt: "interaction",
  provider: "providers",
  providers: "providers",
  reasoning: "model",
  rules: "context",
  search: "tools",
  shell: "shell",
  skills: "context",
  speech: "interaction",
  speechgen: "interaction",
  task: "tasks",
  terminal: "shell",
  theme: "appearance",
  thinking: "model",
  tier: "model",
  tool: "tools",
  tools: "tools",
  tts: "interaction",
  ttsr: "interaction",
  ui: "appearance",
  web: "tools",
  workspace: "files",
};

const MODEL_SETTING_PATHS: ReadonlySet<string> = new Set([
  "cycleOrder",
  "defaultThinkingLevel",
  "modelRoleStorage",
  "modelRoles",
  "modelTags",
]);

const ADVANCED_TAB = "advanced";

function settingPlacement(path: string): { readonly tab: string; readonly group: string } {
  const dot = path.indexOf(".");
  if (dot <= 0) return { tab: MODEL_SETTING_PATHS.has(path) ? "model" : "general", group: "" };
  const prefix = path.slice(0, dot);
  return { tab: SETTING_TAB_BY_PREFIX[prefix] ?? ADVANCED_TAB, group: prefix };
}

/** Walk the global config document by dotted path. Presence in that document
 * IS the global layer; everything else the runtime reports is a default. */
function globalLayerValue(document: unknown, path: string): unknown {
  let current: unknown = document;
  for (const segment of path.split(".")) {
    if (!isRecord(current)) return undefined;
    current = current[segment];
  }
  return current;
}

function settingMetadataFromConfigEntry(path: string, entry: unknown, globalValue: unknown): Record<string, unknown> {
  const record = isRecord(entry) ? entry : {};
  const value = record.value;
  const sensitive = isSecretLikeKey(path);
  const configured = globalValue !== undefined;
  const placement = settingPlacement(path);
  const metadata: Record<string, unknown> = {
    controlType: settingControlType(record.type, value),
    ...(typeof record.description === "string" && record.description.length > 0
      ? { description: record.description }
      : {}),
    configured,
    sensitive,
    scopes: ["global"],
    tab: placement.tab,
    ...(placement.group === "" ? {} : { group: placement.group }),
  };
  if (sensitive || value === undefined || containsSecretLikeObjectKey(value)) return metadata;
  if (configured) {
    metadata.effective = value;
    metadata.effectiveSource = "global";
  } else {
    // Nothing overrides this path, so what the runtime reports IS the default.
    metadata.default = value;
  }
  return metadata;
}

export function officialSettingsFromConfig(schema: unknown, globalDocument: unknown): Record<string, unknown> {
  if (!isRecord(schema)) return {};
  const settings: Record<string, unknown> = {};
  let published = 0;
  for (const [path, entry] of Object.entries(schema).sort(([left], [right]) => left.localeCompare(right))) {
    if (path.length === 0 || path.length > MAX_SETTING_PATH_BYTES) continue;
    // The wire map is bounded; one row past the cap would reject the whole
    // frame, so drop the tail alphabetically and say so in the log.
    if (published === SETTINGS_PUBLISH_LIMIT) {
      console.warn(`t4-host: official OMP publishes more settings than the wire allows; dropping paths after ${path}`);
      break;
    }
    settings[path] = settingMetadataFromConfigEntry(path, entry, globalLayerValue(globalDocument, path));
    published += 1;
  }
  return settings;
}

/** The profile's global config document, or `{}` when the profile has none. */
async function officialGlobalConfigDocument(config: HostDaemonConfig): Promise<unknown> {
  const profileDir = (
    await runOfficialOmp(config, ["config", "path"], VERSION_OUTPUT_BYTES, SETTINGS_CATALOG_TIMEOUT_MS, "config path")
  ).trim();
  if (profileDir.length === 0 || !isAbsolute(profileDir)) return {};
  const file = Bun.file(join(profileDir, "config.yml"));
  if (!(await file.exists())) return {};
  const text = await file.text();
  if (text.length > SETTINGS_CATALOG_OUTPUT_BYTES) throw new Error("official OMP config document is too large");
  return Bun.YAML.parse(text);
}

async function officialSettingsMetadata(config: HostDaemonConfig): Promise<Record<string, unknown>> {
  const [schema, globalDocument] = await Promise.all([
    runOfficialOmp(
      config,
      ["config", "list", "--json"],
      SETTINGS_CATALOG_OUTPUT_BYTES,
      SETTINGS_CATALOG_TIMEOUT_MS,
      "settings catalog",
    ).then(stdout => JSON.parse(stdout) as unknown),
    officialGlobalConfigDocument(config).catch(() => ({})),
  ]);
  return officialSettingsFromConfig(schema, globalDocument);
}

export interface OfficialSettingsEdit {
  readonly path: string;
  readonly scope?: string;
  readonly value?: unknown;
  readonly reset?: boolean;
}

function refuse(message: string, code: string): Error {
  return Object.assign(new Error(message), { code });
}

/** `omp config set` takes scalars verbatim and structures as JSON. */
function settingWriteArgument(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined) throw refuse("settings edit is missing a value", "UNSUPPORTED");
  return JSON.stringify(value);
}

function officialSettingsEdits(args: unknown): readonly OfficialSettingsEdit[] {
  const raw = isRecord(args) ? args.edits : undefined;
  if (!Array.isArray(raw) || raw.length === 0) throw refuse("settings write carried no edits", "UNSUPPORTED");
  if (raw.length > SETTINGS_WRITE_EDIT_LIMIT) throw refuse("too many settings edits", "UNSUPPORTED");
  return raw.map(entry => {
    if (!isRecord(entry) || typeof entry.path !== "string" || entry.path.length === 0)
      throw refuse("settings edit is malformed", "UNSUPPORTED");
    return {
      path: entry.path,
      ...(typeof entry.scope === "string" ? { scope: entry.scope } : {}),
      ...(entry.reset === true ? { reset: true } : { value: entry.value }),
    };
  });
}

/** Refuse anything this authority cannot honestly write before any runtime
 * process starts, so a rejected batch never lands half-applied. */
function assertWritableSettingsEdits(
  settings: Record<string, unknown>,
  edits: readonly OfficialSettingsEdit[],
): void {
  for (const edit of edits) {
    const metadata = settings[edit.path];
    if (!isRecord(metadata)) throw refuse(`unknown setting path: ${edit.path}`, "NOT_FOUND");
    if (edit.scope !== undefined && edit.scope !== "global")
      throw refuse("this host only writes settings for the whole machine", "UNSUPPORTED");
    if (metadata.sensitive === true)
      throw refuse("secret settings are managed by the runtime, not this app", "FORBIDDEN");
    if (edit.reset !== true) settingWriteArgument(edit.value);
  }
}

async function applyOfficialSettingsEdits(
  config: HostDaemonConfig,
  edits: readonly OfficialSettingsEdit[],
): Promise<void> {
  for (const edit of edits) {
    const argv = edit.reset === true
      ? ["config", "reset", edit.path]
      : ["config", "set", edit.path, settingWriteArgument(edit.value)];
    await runOfficialOmp(config, argv, VERSION_OUTPUT_BYTES, SETTINGS_CATALOG_TIMEOUT_MS, "settings write");
  }
}

function officialSettingCatalogItems(settings: Record<string, unknown>): Record<string, unknown>[] {
  return Object.entries(settings).map(([path, metadata]) => ({
    id: `setting:${path}`,
    kind: "setting",
    name: path,
    supported: true,
    metadata: { path, ...(isRecord(metadata) ? metadata : {}) },
  }));
}

/** Presentation keys (`description`, `tab`, `group`) live on the catalog item;
 * the settings frame carries values only. A frame that repeats them is
 * unrecognized value metadata and the renderer refuses the whole row. */
const SETTINGS_FRAME_ITEM_ONLY_KEYS: ReadonlySet<string> = new Set(["description", "group", "label", "path", "tab"]);

export function officialSettingsFrameValues(settings: Record<string, unknown>): Record<string, unknown> {
  const frame: Record<string, unknown> = {};
  for (const [path, metadata] of Object.entries(settings)) {
    if (!isRecord(metadata)) continue;
    frame[path] = Object.fromEntries(
      Object.entries(metadata).filter(([key]) => !SETTINGS_FRAME_ITEM_ONLY_KEYS.has(key)),
    );
  }
  return frame;
}

function settingsRevision(settings: Record<string, unknown>): string {
  return `official-settings-${createHash("sha256").update(JSON.stringify(settings)).digest("hex").slice(0, 16)}`;
}

function officialCatalogItems(
  modelItems: readonly Record<string, unknown>[] = [],
  settings: Record<string, unknown> = {},
): Record<string, unknown>[] {
  return [...officialCommandCatalogItems(), ...modelItems, ...officialSettingCatalogItems(settings)];
}

export interface HostDaemonConfig {
  readonly ompExecutable: string;
  readonly authorityMode?: "bridge" | "official";
  readonly ompSessionsRoot?: string;
  readonly profileId: string;
  readonly stateRoot: string;
  readonly remote?: {
    readonly mode: "direct" | "serve";
    readonly address: string;
    readonly port: number;
    readonly origins: readonly string[];
    readonly trustedServeProxy: boolean;
  };
}

export interface HostDaemonPaths {
  readonly profileStateRoot: string;
  readonly hostIdPath: string;
  readonly attentionOutcomePath: string;
  readonly sessionOwnershipPath: string;
  readonly transcriptSearchPath: string;
  readonly officialMetadataPath: string;
  readonly remoteStateRoot: string;
  readonly socketPath: string;
}

function value(argv: readonly string[], index: number, flag: string): string {
  const result = argv[index + 1];
  if (!result || result.startsWith("--")) throw new Error(`${flag} requires a value`);
  return result;
}

function boundedOrigin(input: string): string {
  const url = new URL(input);
  if (
    (url.protocol !== "https:" && url.protocol !== "http:") ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  )
    throw new Error(
      "--remote-origin must be an HTTP origin without credentials, path, query, or fragment",
    );
  return url.origin;
}

export function parseHostDaemonArgs(argv: readonly string[], home = homedir()): HostDaemonConfig {
  if (argv[0] !== "serve") throw new Error("t4-host requires the serve action");
  let ompExecutable: string | undefined;
  let authorityMode: "bridge" | "official" = "bridge";
  let ompSessionsRoot: string | undefined;
  let profileId = "default";
  let stateRoot = join(home, ".t4-code", "host");
  let remoteMode: "direct" | "serve" | undefined;
  let remoteAddress: string | undefined;
  let remotePort = 8787;
  let trustedServeProxy = false;
  const origins: string[] = [];
  for (let index = 1; index < argv.length; index += 1) {
    const flag = argv[index]!;
    if (flag === "--omp") ompExecutable = value(argv, index++, flag);
    else if (flag === "--omp-authority") {
      const mode = value(argv, index++, flag);
      if (mode !== "bridge" && mode !== "official")
        throw new Error("--omp-authority must be bridge or official");
      authorityMode = mode;
    } else if (flag === "--omp-sessions-root") ompSessionsRoot = value(argv, index++, flag);
    else if (flag === "--profile") profileId = value(argv, index++, flag);
    else if (flag === "--state-root") stateRoot = value(argv, index++, flag);
    else if (flag === "--remote-mode") {
      const mode = value(argv, index++, flag);
      if (mode !== "direct" && mode !== "serve")
        throw new Error("--remote-mode must be direct or serve");
      remoteMode = mode;
    } else if (flag === "--remote-address") remoteAddress = value(argv, index++, flag);
    else if (flag === "--remote-port") {
      remotePort = Number(value(argv, index++, flag));
      if (!Number.isSafeInteger(remotePort) || remotePort < 1 || remotePort > 65_535)
        throw new Error("--remote-port must be between 1 and 65535");
    } else if (flag === "--remote-origin") {
      if (origins.length >= ORIGIN_LIMIT) throw new Error("too many --remote-origin values");
      origins.push(boundedOrigin(value(argv, index++, flag)));
    } else if (flag === "--trusted-serve-proxy") trustedServeProxy = true;
    else throw new Error(`unsupported t4-host argument: ${flag}`);
  }
  if (!ompExecutable || !isAbsolute(ompExecutable))
    throw new Error("--omp must name an absolute executable path");
  if (!PROFILE.test(profileId)) throw new Error("--profile is invalid");
  if (!isAbsolute(stateRoot)) throw new Error("--state-root must be absolute");
  if (authorityMode === "official" && (!ompSessionsRoot || !isAbsolute(ompSessionsRoot)))
    throw new Error("official OMP authority requires an absolute --omp-sessions-root");
  if (authorityMode === "bridge" && ompSessionsRoot)
    throw new Error("--omp-sessions-root requires official OMP authority");
  if (!remoteMode && (remoteAddress || origins.length || trustedServeProxy || remotePort !== 8787))
    throw new Error("remote flags require --remote-mode");
  if (remoteMode && !remoteAddress) throw new Error("remote mode requires --remote-address");
  if (remoteMode === "serve" && remoteAddress !== "127.0.0.1" && remoteAddress !== "::1")
    throw new Error("serve mode requires a loopback address");
  if (remoteMode === "serve" && !trustedServeProxy)
    throw new Error("serve mode requires --trusted-serve-proxy");
  if (remoteMode === "direct" && trustedServeProxy)
    throw new Error("trusted Serve proxy is invalid in direct mode");
  return {
    ompExecutable: resolve(ompExecutable),
    authorityMode,
    ...(ompSessionsRoot ? { ompSessionsRoot: resolve(ompSessionsRoot) } : {}),
    profileId,
    stateRoot: resolve(stateRoot),
    ...(remoteMode
      ? {
          remote: {
            mode: remoteMode,
            address: remoteAddress!,
            port: remotePort,
            origins,
            trustedServeProxy,
          },
        }
      : {}),
  };
}
function authorityBridgeInvocation(config: HostDaemonConfig): OmpAuthorityBridgeInvocation {
  return {
    executable: config.ompExecutable,
    argv: ["bridge", "--stdio"],
    environment: { OMP_PROFILE: config.profileId },
  };
}

function sessionRpcChildInvocation(config: HostDaemonConfig): RpcChildInvocation {
  return {
    executable: config.ompExecutable,
    // OMP session RPC is a top-level `omp --mode rpc` launch. The authority
    // bridge is the separate `omp bridge --stdio` process above.
    prefixArgv: [],
  };
}


export function hostDaemonPaths(
  config: Pick<HostDaemonConfig, "profileId" | "stateRoot">,
): HostDaemonPaths {
  const profileKey = createHash("sha256")
    .update(config.profileId, "utf8")
    .digest("hex")
    .slice(0, 24);
  const profileStateRoot = join(config.stateRoot, "profiles", profileKey);
  return {
    profileStateRoot,
    hostIdPath: join(profileStateRoot, "host-id"),
    attentionOutcomePath: join(profileStateRoot, "attention-outcomes.json"),
    sessionOwnershipPath: join(profileStateRoot, "owned-sessions.json"),
    transcriptSearchPath: join(profileStateRoot, "transcript-search.sqlite"),
    officialMetadataPath: join(profileStateRoot, "official-omp-sessions.json"),
    remoteStateRoot: join(profileStateRoot, "remote"),
    socketPath: profileSocketPath(config.profileId),
  };
}

export interface HostDaemonDependencies {
  readonly createBridge?: (config: HostDaemonConfig, invocation: OmpAuthorityBridgeInvocation) => OmpAuthorityBridgeClient;
  readonly createOfficialAuthority?: (
    config: HostDaemonConfig,
    paths: HostDaemonPaths,
  ) => OfficialOmpProfileAuthority;
  readonly createTranscriptSearch?: (path: string) => TranscriptSearchIndex;
  readonly createLocal?: (options: AppserverOptions) => AppserverHandle;
  readonly createRemote?: typeof createRemoteAppserver;
  readonly verifyOfficialRuntime?: (executable: string) => Promise<Pick<AppserverOptions, "ompVersion" | "ompBuild">>;
  readonly listOfficialModelCatalogItems?: (config: HostDaemonConfig) => Promise<readonly Record<string, unknown>[]>;
  readonly listOfficialSettingsMetadata?: (config: HostDaemonConfig) => Promise<Record<string, unknown>>;
  readonly applyOfficialSettingsEdits?: (
    config: HostDaemonConfig,
    edits: readonly OfficialSettingsEdit[],
  ) => Promise<void>;
  readonly onSignal?: (signal: "SIGINT" | "SIGTERM", listener: () => void) => void;
  readonly removeSignal?: (signal: "SIGINT" | "SIGTERM", listener: () => void) => void;
}

async function boundedProcessOutput(stream: ReadableStream<Uint8Array>, maxBytes: number): Promise<string> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) throw new Error("official OMP version output exceeds 4 KiB");
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const output = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(output);
}

export async function verifyOfficialRuntime(
  executable: string,
): Promise<Pick<AppserverOptions, "ompVersion" | "ompBuild">> {
  const child = Bun.spawn([executable, "--version"], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: {},
  });
  const timer = setTimeout(() => child.kill(), VERSION_TIMEOUT_MS);
  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      boundedProcessOutput(child.stdout, VERSION_OUTPUT_BYTES),
      boundedProcessOutput(child.stderr, VERSION_OUTPUT_BYTES),
      child.exited,
    ]);
    if (exitCode !== 0) throw new Error(`official OMP version probe failed (${exitCode}): ${stderr.trim()}`);
    if (stdout.trim() !== `omp/${OFFICIAL_OMP_VERSION}`)
      throw new Error(`official OMP runtime must report omp/${OFFICIAL_OMP_VERSION}`);
    return { ompVersion: OFFICIAL_OMP_VERSION, ompBuild: OFFICIAL_OMP_BUILD };
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null) child.kill();
  }
}

export async function runHostDaemon(
  config: HostDaemonConfig,
  dependencies: HostDaemonDependencies = {},
): Promise<void> {
  const paths = hostDaemonPaths(config);
  await mkdir(paths.profileStateRoot, { recursive: true, mode: 0o700 });
  let bridge: OmpAuthorityBridgeClient | undefined;
  let officialAuthority: OfficialOmpProfileAuthority | undefined;
  let sessionAuthority: SessionAuthority;
  let discovery: SessionDiscovery;
  let operationsAuthority: DesktopOperationsAuthority = {};
  let usageAuthority: AppserverOptions["usageAuthority"];
  let transcriptImageRoot: string | undefined;
  let identity: Pick<AppserverOptions, "ompVersion" | "ompBuild"> = {};
  let projectRootForProject: (projectId: ProjectId) => Promise<string> | string;
  let projectRootForSession: (sessionId: SessionId) => Promise<string>;
  let lockCheck: NonNullable<AppserverOptions["lockCheck"]>;
  let lockStatus: NonNullable<AppserverOptions["lockStatus"]>;
  if (config.authorityMode === "official") {
    identity = await (dependencies.verifyOfficialRuntime ?? verifyOfficialRuntime)(config.ompExecutable);
    const official =
      dependencies.createOfficialAuthority?.(config, paths) ??
      new OfficialOmpProfileAuthority({
        sessionsRoot: config.ompSessionsRoot!,
        metadataPath: paths.officialMetadataPath,
      });
    await official.initialize();
    officialAuthority = official;
    sessionAuthority = official;
    discovery = official;
    let modelCatalogItems: Promise<readonly Record<string, unknown>[]> | undefined;
    const loadModelCatalogItems = (): Promise<readonly Record<string, unknown>[]> => {
      modelCatalogItems ??= (dependencies.listOfficialModelCatalogItems ?? officialModelCatalogItems)(config).catch(() => []);
      return modelCatalogItems;
    };
    const loadSessionModelCatalogItems = (): Promise<readonly Record<string, unknown>[]> =>
      officialSessionModelCatalogItems(official).catch(() => []);
    // `omp config set` from a terminal changes the same file this authority
    // reads, so the snapshot expires; the TTL still collapses the bootstrap
    // burst (catalog.get + settings.read arrive together) into one probe.
    let settingsMetadata: Promise<Record<string, unknown>> | undefined;
    let settingsMetadataAt = 0;
    const loadSettingsMetadata = (): Promise<Record<string, unknown>> => {
      if (settingsMetadata === undefined || Date.now() - settingsMetadataAt > SETTINGS_CACHE_TTL_MS) {
        settingsMetadataAt = Date.now();
        settingsMetadata = (dependencies.listOfficialSettingsMetadata ?? officialSettingsMetadata)(config).catch(() => ({}));
      }
      return settingsMetadata;
    };
    operationsAuthority = {
      catalogGet: async () => {
        const [modelItems, settings] = await Promise.all([
          Promise.all([loadModelCatalogItems(), loadSessionModelCatalogItems()]).then(groups => mergeOfficialModelCatalogItems(...groups)),
          loadSettingsMetadata(),
        ]);
        return {
          revision: `official-omp-${OFFICIAL_OMP_VERSION}-${settingsRevision(settings)}`,
          items: officialCatalogItems(modelItems, settings),
        };
      },
      settingsRead: async () => {
        const settings = await loadSettingsMetadata();
        return {
          revision: settingsRevision(settings),
          settings: officialSettingsFrameValues(settings),
        };
      },
      settingsWrite: async (args, context) => {
        const settings = await loadSettingsMetadata();
        const revision = settingsRevision(settings);
        const expected = context.expectedRevision ?? (isRecord(args) ? args.expectedRevision : undefined);
        if (typeof expected === "string" && expected !== revision)
          throw refuse("settings revision is stale", "STALE_REVISION");
        const edits = officialSettingsEdits(args);
        assertWritableSettingsEdits(settings, edits);
        try {
          await (dependencies.applyOfficialSettingsEdits ?? applyOfficialSettingsEdits)(config, edits);
        } finally {
          // Any partially applied batch must still republish; the next read
          // re-derives the truth from the runtime rather than from this cache.
          settingsMetadata = undefined;
        }
        return { revision: settingsRevision(await loadSettingsMetadata()) };
      },
    };
    projectRootForProject = projectId => official.projectRootForProject(projectId);
    projectRootForSession = sessionId => official.projectRootForSession(sessionId);
    lockCheck = session => official.lockCheck(session);
    lockStatus = () => official.lockStatus();
  } else {
    const invocation = authorityBridgeInvocation(config);
    bridge =
      dependencies.createBridge?.(config, invocation) ??
      new OmpAuthorityBridgeClient(invocation);
    try {
      await bridge.start();
      const authorities = bridge.createAuthorities();
      const hostInfo = await authorities.hostInfo();
      sessionAuthority = authorities.sessionAuthority;
      discovery = authorities.discovery;
      operationsAuthority = authorities.operationsAuthority;
      usageAuthority = authorities.usageAuthority;
      transcriptImageRoot = hostInfo.transcriptImageRoot;
      identity = bridge.identity;
      projectRootForProject = authorities.projectRootForProject;
      projectRootForSession = authorities.projectRootForSession;
      lockCheck = authorities.lockCheck;
      lockStatus = authorities.lockStatus;
    } catch (error) {
      await bridge.stop();
      throw error;
    }
  }
  try {
    const transcriptSearchAuthority =
      dependencies.createTranscriptSearch?.(paths.transcriptSearchPath) ??
      new TranscriptSearchIndex(paths.transcriptSearchPath);
    const projectFileSearchAuthority = new ProjectFileSearchAuthority(
      projectRootForSession,
    );
    const options: AppserverOptions = {
      ...identity,
      appserverVersion: T4_HOST_VERSION,
      appserverBuild: process.env.T4_HOST_BUILD?.slice(0, 128) || "source",
      socketPath: paths.socketPath,
      hostIdPath: paths.hostIdPath,
      attentionOutcomePath: paths.attentionOutcomePath,
      sessionOwnershipPath: paths.sessionOwnershipPath,
      sessionAuthority,
      discovery,
      operationsAuthority: {
        ...operationsAuthority,
        ...projectFileSearchAuthority.operations(),
      },
      ...(usageAuthority ? { usageAuthority } : {}),
      transcriptSearchAuthority,
      projectRootForProject,
      lockCheck,
      lockStatus,
      // Local desktop daemon (official, or non-remote bridge): claim lockless
      // (no-lock) sessions so omp-CLI sessions become writable in T4. A live owner
      // holds a "live" lock and is never lockless, and startSupervisor still acquires
      // the write-lock at spawn, so this cannot displace an active owner. Remote/shared
      // bridge authority keeps the conservative "unclear ownership stays read-only".
      ...(config.authorityMode === "official" || !config.remote ? { claimLocklessSessions: true } : {}),
      ...(transcriptImageRoot ? { transcriptImageRoot } : {}),
      rpcChildInvocation: sessionRpcChildInvocation(config),
      rpcChildEnvironment: { OMP_PROFILE: config.profileId },
      ...(config.authorityMode === "official" ? { rpcDialect: "official-17.0.9" as const } : {}),
      ...(process.platform === "darwin"
        ? {
            projectRevealer: async (root: string): Promise<boolean> => {
              const child = Bun.spawn(["/usr/bin/open", "-R", root], {
                stdout: "ignore",
                stderr: "ignore",
              });
              return (await child.exited) === 0;
            },
          }
        : {}),
    };
    let appserver: AppserverHandle;
    try {
      appserver = config.remote
        ? await (dependencies.createRemote ?? createRemoteAppserver)({
            stateDir: paths.remoteStateRoot,
            remoteEndpoint: {
              address: config.remote.address,
              port: config.remote.port,
              originAllowlist: config.remote.origins,
              serveProxy: config.remote.mode === "serve",
              trustedServeProxy: config.remote.trustedServeProxy,
            },
            appserver: options,
          })
        : (dependencies.createLocal ?? createAppserver)(options);
    } catch (error) {
      await Promise.resolve(transcriptSearchAuthority.close()).catch(() => undefined);
      throw error;
    }
    const stopped = Promise.withResolvers<void>();
    let stopping = false;
    const stop = (): void => {
      if (stopping) return;
      stopping = true;
      void appserver.stop().then(stopped.resolve, stopped.reject);
    };
    const onSignal = dependencies.onSignal ?? ((signal, listener) => process.on(signal, listener));
    const removeSignal =
      dependencies.removeSignal ?? ((signal, listener) => process.off(signal, listener));
    onSignal("SIGINT", stop);
    onSignal("SIGTERM", stop);
    try {
      await appserver.start();
      const bridgeFailure = bridge
        ? await Promise.race([
            stopped.promise.then<Error | undefined>(() => undefined),
            bridge.closed,
          ])
        : await stopped.promise.then<Error | undefined>(() => undefined);
      if (bridgeFailure) {
        process.stderr.write(
          `t4-host: OMP authority bridge closed unexpectedly; exiting so the service restarts: ${bridgeFailure.message}\n`,
        );
        stop();
        await Promise.race([
          stopped.promise.catch(() => undefined),
          new Promise<void>(resolve => setTimeout(resolve, SHUTDOWN_GRACE_MS)),
        ]);
        throw bridgeFailure;
      }
    } finally {
      removeSignal("SIGINT", stop);
      removeSignal("SIGTERM", stop);
      if (!stopping) await appserver.stop().catch(() => undefined);
    }
  } finally {
    await bridge?.stop();
    await officialAuthority?.close();
  }
}

async function main(): Promise<void> {
  try {
    await runHostDaemon(parseHostDaemonArgs(process.argv.slice(2)));
  } catch (error) {
    process.stderr.write(
      `t4-host error: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  }
  // The appserver's listener and a half-dead bridge can leave open handles that keep this process
  // alive after the daemon logic has finished. Exit explicitly so a crashed bridge always yields a
  // clean restart instead of an unreachable, never-restarted host.
  process.exit(process.exitCode ?? 0);
}

if (import.meta.main) await main();
