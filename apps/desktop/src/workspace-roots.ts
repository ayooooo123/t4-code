import { lstat, mkdir, realpath, writeFile } from "node:fs/promises";
import { basename, join, relative, resolve, sep } from "node:path";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { homedir } from "node:os";

export interface WorkspaceRoot {
  readonly id: string;
  readonly label: string;
}

export interface WorkspaceProject {
  readonly id: string;
  readonly name: string;
}

interface StoredRoot extends WorkspaceRoot { readonly path: string; }
export interface WorkspaceRootsRecord {
  readonly version: 1;
  readonly roots: readonly StoredRoot[];
  readonly activeRootId: string | null;
}

export interface WorkspaceRootsStore {
  load(): Promise<unknown>;
  save(value: WorkspaceRootsRecord): Promise<void>;
}

export interface WorkspaceRootsServiceOptions {
  readonly store: WorkspaceRootsStore;
  readonly ids?: () => string;
  /** OMP's session home; configurable for non-default OMP installs and tests. */
  readonly agentDirectory?: string;
  readonly homeDirectory?: string;
  readonly now?: () => number;
  readonly sessionIds?: () => string;
}

function within(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !path.startsWith(sep));
}

function safeName(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._ -]{0,80}$/u.test(value) && value !== "." && value !== "..";
}

function uuidV7(now: number): string {
  const bytes = randomBytes(16);
  for (let index = 5; index >= 0; index--) bytes[index] = Math.floor(now / (256 ** (5 - index))) & 0xff;
  bytes[6] = (bytes[6]! & 0x0f) | 0x70;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function titleSlot(updatedAt: string): string {
  const line = (pad: string): string => `${JSON.stringify({ type: "title", v: 1, title: "", updatedAt, pad })}\n`;
  const value = line(" ".repeat(256 - Buffer.byteLength(line(""), "utf8")));
  if (Buffer.byteLength(value, "utf8") !== 256) throw new Error("could not create OMP session title slot");
  return value;
}

function record(value: unknown): WorkspaceRootsRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return { version: 1, roots: [], activeRootId: null };
  const data = value as Partial<WorkspaceRootsRecord>;
  if (data.version !== 1 || !Array.isArray(data.roots)) return { version: 1, roots: [], activeRootId: null };
  const roots = data.roots.filter((root): root is StoredRoot => root !== null && typeof root === "object" &&
    typeof (root as StoredRoot).id === "string" && typeof (root as StoredRoot).label === "string" && typeof (root as StoredRoot).path === "string");
  const activeRootId = typeof data.activeRootId === "string" && roots.some((root) => root.id === data.activeRootId) ? data.activeRootId : null;
  return { version: 1, roots, activeRootId };
}

export class WorkspaceRootsService {
  private readonly store: WorkspaceRootsStore;
  private readonly ids: () => string;
  private readonly agentDirectory: string;
  private readonly homeDirectory: string;
  private readonly now: () => number;
  private readonly sessionIds: () => string;
  constructor(options: WorkspaceRootsServiceOptions) {
    this.store = options.store;
    this.ids = options.ids ?? randomUUID;
    this.agentDirectory = options.agentDirectory ?? process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".omp", "agent");
    this.homeDirectory = options.homeDirectory ?? homedir();
    this.now = options.now ?? Date.now;
    this.sessionIds = options.sessionIds ?? (() => uuidV7(this.now()));
  }

  async list(): Promise<{ readonly roots: readonly WorkspaceRoot[]; readonly activeRootId: string | null }> {
    const value = record(await this.store.load());
    return { roots: value.roots.map(({ id, label }) => ({ id, label })), activeRootId: value.activeRootId };
  }

  async addRoot(input: string): Promise<WorkspaceRoot> {
    const path = await this.directory(input);
    const value = record(await this.store.load());
    const existing = value.roots.find((root) => root.path === path);
    if (existing !== undefined) return { id: existing.id, label: existing.label };
    const root = { id: this.ids(), label: basename(path), path };
    await this.store.save({ version: 1, roots: [...value.roots, root], activeRootId: value.activeRootId ?? root.id });
    return { id: root.id, label: root.label };
  }

  async selectRoot(id: string): Promise<void> {
    const value = record(await this.store.load());
    if (!value.roots.some((root) => root.id === id)) throw new Error("workspace root is not approved");
    await this.store.save({ ...value, activeRootId: id });
  }

  async createProject(name: string): Promise<WorkspaceProject> {
    if (!safeName(name)) throw new Error("invalid project folder name");
    const value = record(await this.store.load());
    const root = value.roots.find((entry) => entry.id === value.activeRootId);
    if (root === undefined) throw new Error("no active workspace root");
    const canonicalRoot = await this.directory(root.path);
    const target = resolve(canonicalRoot, name);
    if (!within(canonicalRoot, target)) throw new Error("project must stay inside the active root");
    await mkdir(target, { mode: 0o700, recursive: true });
    const canonicalTarget = await realpath(target);
    if (!within(canonicalRoot, canonicalTarget)) throw new Error("project must stay inside the active root");
    const stat = await lstat(canonicalTarget);
    if (!stat.isDirectory()) throw new Error("project is not a directory");
    // OMP derives a stable opaque project id from the canonical working
    // directory. `session.create` accepts this identifier, never a path.
    const projectId = `project-${createHash("sha256").update(canonicalTarget).digest("hex").slice(0, 24)}`;
    await this.createEmptyOmpSession(canonicalTarget);
    return { id: projectId, name };
  }

  private async createEmptyOmpSession(cwd: string): Promise<void> {
    // OMP derives session-directory names from canonical paths. This matters on
    // macOS, where /var is a symlink to /private/var (and for symlinked homes).
    const canonicalHome = await realpath(this.homeDirectory).catch(() => resolve(this.homeDirectory));
    const homeRelative = relative(canonicalHome, cwd);
    const directoryName = within(canonicalHome, cwd)
      ? `-${homeRelative.replace(/[\\/:]/gu, "-")}`
      : `--${cwd.replace(/^[/\\]/u, "").replace(/[\\/:]/gu, "-")}--`;
    const sessionDirectory = join(this.agentDirectory, "sessions", directoryName);
    const timestamp = new Date(this.now()).toISOString();
    const sessionId = this.sessionIds();
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(sessionId)) {
      throw new Error("could not create OMP session id");
    }
    const sessionFile = join(sessionDirectory, `${timestamp.replace(/[:.]/gu, "-")}_${sessionId}.jsonl`);
    const header = `${JSON.stringify({ type: "session", version: 3, id: sessionId, timestamp, cwd })}\n`;
    await mkdir(sessionDirectory, { recursive: true, mode: 0o700 });
    await writeFile(sessionFile, titleSlot(timestamp) + header, { encoding: "utf8", flag: "wx", mode: 0o600 });
  }

  private async directory(input: string): Promise<string> {
    let path: string;
    try { path = await realpath(input); } catch { throw new Error("workspace root must be an existing directory"); }
    const stat = await lstat(path);
    if (!stat.isDirectory()) throw new Error("workspace root must be an existing directory");
    return path;
  }
}
