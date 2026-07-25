import { describe, expect, it } from "vite-plus/test";

import { mergeWorkspaceProjects } from "../src/state/shell-data.ts";

describe("workspace rail project overlay", () => {
  it("keeps a newly-created folder visible before it has an OMP session", () => {
    const result = mergeWorkspaceProjects(
      {
        hosts: [{ id: "host-1", runtimeKind: "omp", name: "Desktop", kind: "local" as const }],
        projects: [],
        sessions: [],
      },
      [{ hostId: "host-1", projectId: "/Users/me/Projects/PearTube", name: "PearTube" }],
    );

    expect(result.projects).toEqual([
      { id: "host-1/%2FUsers%2Fme%2FProjects%2FPearTube", hostId: "host-1", name: "PearTube", path: "PearTube" },
    ]);
  });

  it("does not duplicate a folder once OMP advertises a session in it", () => {
    const result = mergeWorkspaceProjects(
      {
        hosts: [{ id: "host-1", runtimeKind: "omp", name: "Desktop", kind: "local" as const }],
        projects: [{ id: "host-1/%2FUsers%2Fme%2FProjects%2FPearTube", hostId: "host-1", name: "PearTube", path: "PearTube" }],
        sessions: [],
      },
      [{ hostId: "host-1", projectId: "/Users/me/Projects/PearTube", name: "PearTube" }],
    );

    expect(result.projects).toHaveLength(1);
  });
});
