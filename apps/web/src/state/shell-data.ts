// The one seam components read workspace display data through. Desktop mode
// projects the live runtime snapshot; browser mode serves the built-in
// sample workspace. Nothing above this file knows which provider fed it,
// and the desktop path never reads fixture data.
import type { WorkspaceData } from "../lib/workspace-data.ts";
import {
  desktopRuntime,
  useDesktopRuntimeSelector,
} from "../platform/desktop-runtime.ts";
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

type WorkspaceSnapshot = Parameters<typeof deriveWorkspaceData>[0];

function warmWorkspaceStateEqual(
  left: WorkspaceSnapshot["projection"]["sessions"],
  right: WorkspaceSnapshot["projection"]["sessions"],
): boolean {
  if (left === right) return true;
  if (left.size !== right.size) return false;
  for (const [key, next] of right) {
    const previous = left.get(key);
    if (
      previous === undefined ||
      previous.freshness !== next.freshness ||
      previous.confirmations.size !== next.confirmations.size
    ) {
      return false;
    }
  }
  return true;
}

/**
 * Workspace display truth changes far less often than transcript truth.
 * Ignore entry/event churn while retaining every input that can affect rail
 * grouping, freshness, ownership, capability, or pending-approval display.
 */
export function workspaceSnapshotEqual(
  left: WorkspaceSnapshot,
  right: WorkspaceSnapshot,
): boolean {
  return (
    left.integration === right.integration &&
    left.targets === right.targets &&
    left.connections === right.connections &&
    left.targetHosts === right.targetHosts &&
    left.hosts === right.hosts &&
    left.catalogs === right.catalogs &&
    left.clusterOperatorEnabled === right.clusterOperatorEnabled &&
    left.projection.sessionIndex === right.projection.sessionIndex &&
    left.projection.sessionIndexMetadata === right.projection.sessionIndexMetadata &&
    left.projection.sessionRefArrivalOrdinals ===
      right.projection.sessionRefArrivalOrdinals &&
    left.projection.workspaces === right.projection.workspaces &&
    warmWorkspaceStateEqual(left.projection.sessions, right.projection.sessions)
  );
}

/** Reactive workspace data for components. */
export function useShellData(): WorkspaceData {
  const snapshot = useWorkspaceRuntimeSnapshot();
  const pending = useWorkspace((state) => state.workspaceProjects);
  return mergeWorkspaceProjects(snapshot === null ? SHELL_FIXTURE : deriveWorkspaceData(snapshot), pending);
}

/** Reactive snapshot containing only changes relevant to workspace chrome. */
export function useWorkspaceRuntimeSnapshot(): WorkspaceSnapshot | null {
  return useDesktopRuntimeSelector((value) => value, workspaceSnapshotEqual);
}

/** Point-in-time workspace data for event handlers outside render. */
export function getShellData(): WorkspaceData {
  const controller = desktopRuntime();
  return mergeWorkspaceProjects(controller === null ? SHELL_FIXTURE : deriveWorkspaceData(controller.getSnapshot()), workspaceStore.getState().workspaceProjects);
}
