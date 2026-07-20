import {
  CI_TRIGGER_CAPABILITY,
  CLUSTER_OPERATOR_FEATURE,
  hostId,
  revision,
  sessionId,
  type SessionRef,
  type WorkspaceInfrastructureProjection,
} from "@t4-code/protocol";
import {
  createProjectionSnapshot,
  type DesktopRuntimeController,
  type DesktopRuntimeSnapshot,
} from "@t4-code/client";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  clusterOperatorAvailability,
  createClusterSession,
  createClusterWorkspace,
  runClusterCi,
} from "../src/features/targets/cluster-operator.ts";
import { deriveWorkspaceData } from "../src/platform/live-workspace.ts";

const HOST = "cluster-host";
const TARGET = "cluster-target";
const workspace: WorkspaceInfrastructureProjection = {
  id: "workspace-a",
  displayName: "Release train",
  phase: "Ready",
  retentionPolicy: "Retain",
  storageClass: "t4-workspaces-rwx",
  capacity: "20Gi",
  accessMode: "ReadWriteMany",
  revision: revision("workspace-r2"),
  condition: {
    type: "StorageReady",
    status: "True",
    reason: "Bound",
    message: "The RWX claim is bound.",
    observedGeneration: 2,
  },
};

function snapshot(options: {
  readonly enabled?: boolean;
  readonly connected?: boolean;
  readonly features?: readonly string[];
  readonly capabilities?: readonly string[];
  readonly session?: SessionRef;
  readonly workspace?: WorkspaceInfrastructureProjection;
} = {}): DesktopRuntimeSnapshot {
  const projection = createProjectionSnapshot();
  return {
    version: 1,
    integration: { kind: "omp", displayName: "OMP", level: "first-party" },
    platform: "linux",
    desktopVersion: "test",
    startState: "started",
    clusterOperatorEnabled: options.enabled ?? false,
    targets: new Map([[TARGET, { targetId: TARGET, label: "Cluster", kind: "remote", state: options.connected === false ? "disconnected" : "connected", paired: true }]]),
    connections: new Map([[TARGET, options.connected === false ? "disconnected" : "connected"]]),
    targetHosts: new Map([[TARGET, HOST]]),
    hosts: new Map([[HOST, {
      targetId: TARGET,
      hostId: HOST,
      ompVersion: "17.0.5",
      ompBuild: "8476f445",
      appserverVersion: "1",
      appserverBuild: "test",
      epoch: "host-epoch",
      grantedCapabilities: [...(options.capabilities ?? ["sessions.read", "sessions.manage", "sessions.prompt", "sessions.control", CI_TRIGGER_CAPABILITY])],
      grantedFeatures: [...(options.features ?? [CLUSTER_OPERATOR_FEATURE])],
      negotiatedLimits: {},
      authentication: "paired",
      resumed: false,
    }]]),
    catalogs: new Map(),
    settings: new Map(),
    projection: {
      ...projection,
      workspaces: new Map(options.workspace === undefined ? [] : [[`${HOST}\u0000${options.workspace.id}`, options.workspace]]),
      workspaceCursors: new Map(options.workspace === undefined ? [] : [[HOST, { epoch: "workspace-epoch", seq: 2 }]]),
      sessionIndex: new Map(options.session === undefined ? [] : [[`${HOST}\u0000${String(options.session.sessionId)}`, options.session]]),
      sessionIndexMetadata: new Map(options.session === undefined ? [] : [[HOST, { totalCount: 1, truncated: false }]]),
    },
    runtimeErrors: [],
  } as DesktopRuntimeSnapshot;
}

const session: SessionRef = {
  hostId: hostId(HOST),
  sessionId: sessionId("session-a"),
  project: { projectId: "cluster/workspace-a" as never, name: "Release train" },
  revision: revision("session-r3"),
  title: "Ship release",
  status: "active",
  updatedAt: "2026-07-20T12:00:00.000Z",
  liveState: {
    phase: "running",
    cluster: {
      workspaceId: workspace.id,
      infrastructurePhase: "Running",
      gui: { state: "Ready", previewId: "preview-a" },
    },
    ci: {
      provider: "woodpecker",
      correlation: "exact",
      repositoryId: "repo-a",
      branch: "main",
      ref: "refs/heads/main",
      commit: "0123456789abcdef",
      pipelineNumber: 42,
      status: "running",
      currentStage: "verify",
      startedAt: "2026-07-20T12:01:00.000Z",
      deepLink: "https://ci.tailnet.ts.net/repos/repo-a/pipeline/42",
    },
  },
};

describe("cluster operator presentation", () => {
  it("fails closed with exact disabled, transport, feature, capability, and revision reasons", () => {
    expect(clusterOperatorAvailability(snapshot(), TARGET, "read")).toEqual({
      enabled: false,
      reason: "Cluster operator is disabled in this app.",
    });
    expect(clusterOperatorAvailability(snapshot({ enabled: true, connected: false }), TARGET, "read")).toEqual({
      enabled: false,
      reason: "Reconnect this host to inspect cluster workspaces.",
    });
    expect(clusterOperatorAvailability(snapshot({ enabled: true, features: [] }), TARGET, "read")).toEqual({
      enabled: false,
      reason: "This host does not advertise cluster operator support.",
    });
    expect(clusterOperatorAvailability(snapshot({ enabled: true, capabilities: [] }), TARGET, "read")).toEqual({
      enabled: false,
      reason: "This host did not grant session read access.",
    });
    expect(clusterOperatorAvailability(snapshot({ enabled: true, capabilities: ["sessions.read"] }), TARGET, "manage")).toEqual({
      enabled: false,
      reason: "This host did not grant workspace and session management.",
    });
    expect(clusterOperatorAvailability(snapshot({ enabled: true, capabilities: ["sessions.read", "sessions.manage"] }), TARGET, "ci", revision("session-r3"))).toEqual({
      enabled: false,
      reason: "This host did not grant CI trigger access.",
    });
    expect(clusterOperatorAvailability(snapshot({ enabled: true }), TARGET, "ci")).toEqual({
      enabled: false,
      reason: "Waiting for the latest session revision.",
    });
  });

  it("derives infrastructure, CI, and GUI truth from canonical projections", () => {
    const data = deriveWorkspaceData(snapshot({ enabled: true, workspace, session }));

    expect(data.clusterWorkspaces).toEqual([{ hostId: HOST, targetId: TARGET, infrastructure: workspace }]);
    expect(data.sessions[0]).toMatchObject({
      cluster: session.liveState?.cluster,
      ci: session.liveState?.ci,
    });
    expect(data.sessions[0]?.ci?.currentStage).toBe("verify");
    expect(data.sessions[0]?.cluster?.gui).toEqual({ state: "Ready", previewId: "preview-a" });
  });

  it("sends only allowlisted workspace, session, and CI arguments", async () => {
    const command = vi.fn(async () => ({ accepted: true, result: {} }));
    const controller = { command, getSnapshot: () => snapshot({ enabled: true, workspace, session }) } as unknown as DesktopRuntimeController;

    await createClusterWorkspace(controller, TARGET, HOST, {
      displayName: "Release train",
      retentionPolicy: "Retain",
      capacity: "20Gi",
      storageClass: "t4-workspaces-rwx",
      repository: { repositoryId: "repo-a", ref: "refs/heads/main", commit: "0123456789abcdef" },
    });
    await createClusterSession(controller, TARGET, HOST, {
      workspaceId: workspace.id,
      title: "Ship release",
      runtimeProfile: "default",
      guiEnabled: true,
      ci: { provider: "woodpecker", repositoryId: "repo-a", ref: "refs/heads/main", commit: "0123456789abcdef" },
    });
    await runClusterCi(controller, TARGET, HOST, "session-a", revision("session-r3"), {
      provider: "woodpecker",
      action: "run",
      repositoryId: "repo-a",
      ref: "refs/heads/main",
      commit: "0123456789abcdef",
    });

    expect(command.mock.calls.map(([, intent]) => intent)).toEqual([
      { hostId: HOST, command: "workspace.create", args: expect.objectContaining({ displayName: "Release train", capacity: "20Gi" }) },
      { hostId: HOST, command: "session.create", args: expect.objectContaining({ workspaceId: workspace.id, guiEnabled: true }) },
      { hostId: HOST, sessionId: "session-a", command: "ci.run", expectedRevision: "session-r3", args: expect.objectContaining({ provider: "woodpecker", action: "run", repositoryId: "repo-a" }) },
    ]);
    const serialized = JSON.stringify(command.mock.calls);
    expect(serialized).not.toMatch(/token|secret|kubeconfig|namespace|image|url/iu);
  });
});
