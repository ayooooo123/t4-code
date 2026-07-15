import { lstat, mkdir, realpath } from "node:fs/promises";
import { basename, relative, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";

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
}

function within(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !path.startsWith(sep));
}

function safeName(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._ -]{0,80}$/u.test(value) && value !== "." && value !== "..";
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
  constructor(options: WorkspaceRootsServiceOptions) { this.store = options.store; this.ids = options.ids ?? randomUUID; }

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
    return { id: this.ids(), name };
  }

  private async directory(input: string): Promise<string> {
    let path: string;
    try { path = await realpath(input); } catch { throw new Error("workspace root must be an existing directory"); }
    const stat = await lstat(path);
    if (!stat.isDirectory()) throw new Error("workspace root must be an existing directory");
    return path;
  }
}
