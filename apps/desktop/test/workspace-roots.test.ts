import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";

import { WorkspaceRootsService, type WorkspaceRootsStore } from "../src/workspace-roots.ts";

function store(): WorkspaceRootsStore & { value: unknown } {
  let value: unknown = null;
  return {
    get value() { return value; },
    load: async () => value,
    save: async (next) => { value = next; },
  };
}

describe("WorkspaceRootsService", () => {
  it("accepts canonical directories, selects them, and persists the active root", async () => {
    const base = await mkdtemp(join(tmpdir(), "t4-workspace-"));
    const first = join(base, "first");
    const second = join(base, "second");
    await Promise.all([mkdir(first), mkdir(second)]);
    const memory = store();
    const service = new WorkspaceRootsService({ store: memory, ids: () => "root-a" });

    const added = await service.addRoot(first);
    const secondRoot = await service.addRoot(second);
    await service.selectRoot(secondRoot.id);

    expect(added.label).toBe("first");
    expect((await service.list()).activeRootId).toBe(secondRoot.id);
    expect(memory.value).toMatchObject({ activeRootId: secondRoot.id });
  });

  it("rejects missing paths and files as workspace roots", async () => {
    const base = await mkdtemp(join(tmpdir(), "t4-workspace-"));
    const file = join(base, "not-a-directory");
    await writeFile(file, "nope");
    const service = new WorkspaceRootsService({ store: store() });

    await expect(service.addRoot(join(base, "missing"))).rejects.toThrow("directory");
    await expect(service.addRoot(file)).rejects.toThrow("directory");
  });

  it("creates one safe project folder under the selected root", async () => {
    const base = await mkdtemp(join(tmpdir(), "t4-workspace-"));
    const root = join(base, "projects");
    await mkdir(root);
    const service = new WorkspaceRootsService({ store: store(), ids: (() => {
      let index = 0;
      return () => `id-${++index}`;
    })() });
    await service.addRoot(root);

    const project = await service.createProject("mobile-app");

    expect(project.name).toBe("mobile-app");
    expect(project.id).toBe("id-2");
    await expect(service.createProject("../escape")).rejects.toThrow("folder name");
    await expect(service.createProject("nested/project")).rejects.toThrow("folder name");
  });

  it("refuses a project symlink that escapes the active root", async () => {
    const base = await mkdtemp(join(tmpdir(), "t4-workspace-"));
    const root = join(base, "projects");
    const outside = join(base, "outside");
    await Promise.all([mkdir(root), mkdir(outside)]);
    await symlink(outside, join(root, "escape"));
    const service = new WorkspaceRootsService({ store: store() });
    await service.addRoot(root);

    await expect(service.createProject("escape")).rejects.toThrow("active root");
  });
});
