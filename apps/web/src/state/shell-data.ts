// The one seam components read workspace display data through. Desktop mode
// projects the live runtime snapshot; browser mode serves the built-in
// sample workspace. Nothing above this file knows which provider fed it,
// and the desktop path never reads fixture data.
import type { WorkspaceData } from "../lib/workspace-data.ts";
import { desktopRuntime, useDesktopRuntimeSnapshot } from "../platform/desktop-runtime.ts";
import { deriveWorkspaceData } from "../platform/live-workspace.ts";
import { SHELL_FIXTURE } from "../fixture/data.ts";
import { useWorkspace, workspaceStore } from "./store-instance.ts";
import type { WorkspaceRailProject } from "./workspace-store.ts";

export function mergeWorkspaceProjects(data: WorkspaceData, pending: readonly WorkspaceRailProject[]): WorkspaceData {
  if (pending.length === 0) return data;
  const known = new Set(data.projects.map((project) => project.id));
  const projects = pending
    .filter((project) => data.hosts.some((host) => host.id === project.hostId))
    .map((project) => ({
      id: `${encodeURIComponent(project.hostId)}/${encodeURIComponent(project.projectId)}`,
      hostId: project.hostId,
      name: project.name,
      path: project.name,
    }))
    .filter((project) => !known.has(project.id));
  return projects.length === 0 ? data : { ...data, projects: [...data.projects, ...projects] };
}

/** Reactive workspace data for components. */
export function useShellData(): WorkspaceData {
  const snapshot = useDesktopRuntimeSnapshot();
  const pending = useWorkspace((state) => state.workspaceProjects);
  return mergeWorkspaceProjects(snapshot === null ? SHELL_FIXTURE : deriveWorkspaceData(snapshot), pending);
}

/** Point-in-time workspace data for event handlers outside render. */
export function getShellData(): WorkspaceData {
  const controller = desktopRuntime();
  return mergeWorkspaceProjects(controller === null ? SHELL_FIXTURE : deriveWorkspaceData(controller.getSnapshot()), workspaceStore.getState().workspaceProjects);
}
