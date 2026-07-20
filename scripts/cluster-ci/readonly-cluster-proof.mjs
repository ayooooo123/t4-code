import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const NAMESPACE_PATTERN = /^[a-z0-9](?:[-a-z0-9]{0,61}[a-z0-9])?$/u;
const FORBIDDEN_SESSION_NODES = new Set(["k3s-worker-02", "k3s-worker-03"]);
const WORKLOAD_KINDS = new Set(["CronJob", "DaemonSet", "Deployment", "Job", "Pod", "StatefulSet"]);

const REQUESTS = Object.freeze([
  ["deployments", ["get", "deployments", "-n", "$NAMESPACE", "-l", "app.kubernetes.io/part-of=t4-cluster", "-o", "json"]],
  ["leases", ["get", "leases", "-n", "$NAMESPACE", "-l", "app.kubernetes.io/part-of=t4-cluster", "-o", "json"]],
  [
    "customresourcedefinitions",
    [
      "get",
      "customresourcedefinitions",
      "t4clusterhosts.cluster.t4.dev",
      "t4workspaces.cluster.t4.dev",
      "t4sessions.cluster.t4.dev",
      "-o",
      "json",
    ],
  ],
  ["t4clusterhosts", ["get", "t4clusterhosts", "-n", "$NAMESPACE", "-o", "json"]],
  ["t4workspaces", ["get", "t4workspaces", "-n", "$NAMESPACE", "-o", "json"]],
  ["t4sessions", ["get", "t4sessions", "-n", "$NAMESPACE", "-o", "json"]],
  ["persistentvolumeclaims", ["get", "persistentvolumeclaims", "-n", "$NAMESPACE", "-l", "app.kubernetes.io/part-of=t4-cluster", "-o", "json"]],
  ["pods", ["get", "pods", "-n", "$NAMESPACE", "-l", "app.kubernetes.io/part-of=t4-cluster", "-o", "json"]],
  ["services", ["get", "services", "-n", "$NAMESPACE", "-l", "app.kubernetes.io/part-of=t4-cluster", "-o", "json"]],
]);

function fail(message) {
  throw new Error(`T4 read-only cluster proof ${message}`);
}

function list(snapshot, key) {
  const value = snapshot?.[key];
  if (!value || typeof value !== "object" || !Array.isArray(value.items) || value.items.length > 256) {
    fail(`${key} response was malformed or exceeded its bound`);
  }
  return value.items;
}

function named(items, fragment, label) {
  const matches = items.filter(({ metadata }) => metadata?.name?.includes(fragment));
  if (matches.length !== 1) fail(`expected exactly one ${label}`);
  return matches[0];
}

function positive(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function deploymentContract(deployment, replicas, minimumAvailable, label) {
  if (
    deployment.spec?.replicas !== replicas ||
    deployment.spec?.strategy?.type !== "RollingUpdate" ||
    ![0, "0"].includes(deployment.spec?.strategy?.rollingUpdate?.maxUnavailable) ||
    !positive(deployment.status?.observedGeneration) ||
    (deployment.status?.availableReplicas ?? 0) < minimumAvailable
  ) {
    fail(`${label} Deployment did not satisfy its HA rollout contract`);
  }
}

function defaultRunner(command, args) {
  return execFileAsync(command, args, {
    encoding: "utf8",
    maxBuffer: MAX_RESPONSE_BYTES,
    timeout: 30_000,
    windowsHide: true,
  }).then(({ stdout }) => stdout);
}

export async function collectReadOnlyClusterSnapshot({ namespace, run = defaultRunner }) {
  if (!NAMESPACE_PATTERN.test(namespace ?? "")) fail("namespace is invalid");
  const snapshot = {};
  for (const [key, template] of REQUESTS) {
    const args = template.map((argument) => (argument === "$NAMESPACE" ? namespace : argument));
    const stdout = await run("kubectl", args);
    if (typeof stdout !== "string" || Buffer.byteLength(stdout) > MAX_RESPONSE_BYTES) {
      fail(`${key} response exceeded its byte bound`);
    }
    try {
      snapshot[key] = JSON.parse(stdout);
    } catch {
      fail(`${key} response was not JSON`);
    }
  }
  return snapshot;
}

export function validateClusterSnapshot(snapshot) {
  const deployments = list(snapshot, "deployments");
  deploymentContract(named(deployments, "controller", "controller Deployment"), 2, 1, "controller");
  deploymentContract(named(deployments, "server", "cluster-server Deployment"), 3, 2, "cluster-server");

  const leases = list(snapshot, "leases");
  const leaderLease = named(leases, "controller", "controller leader Lease");
  if (
    typeof leaderLease.spec?.holderIdentity !== "string" ||
    leaderLease.spec.holderIdentity.length < 1 ||
    leaderLease.spec.holderIdentity.length > 253 ||
    !Number.isFinite(Date.parse(leaderLease.spec?.renewTime ?? ""))
  ) {
    fail("controller leader Lease is not currently held");
  }

  const crds = list(snapshot, "customresourcedefinitions");
  const requiredCrds = new Set(["t4clusterhosts", "t4workspaces", "t4sessions"]);
  for (const crd of crds) {
    const version = crd.spec?.versions?.find(({ name }) => name === "v1alpha1");
    if (
      crd.spec?.group === "cluster.t4.dev" &&
      crd.spec?.scope === "Namespaced" &&
      version?.served === true &&
      version?.storage === true
    ) {
      requiredCrds.delete(crd.spec?.names?.plural);
    }
  }
  if (requiredCrds.size > 0) fail(`CRD contract is missing ${[...requiredCrds].join(",")}`);

  const hosts = list(snapshot, "t4clusterhosts");
  if (hosts.length < 1 || !hosts.every((host) => positive(host.status?.observedGeneration))) {
    fail("T4ClusterHost status has not observed the desired generation");
  }

  const workspaces = list(snapshot, "t4workspaces");
  const sessions = list(snapshot, "t4sessions");
  const pvcs = list(snapshot, "persistentvolumeclaims");
  if (workspaces.length < 1 || sessions.length < 1 || pvcs.length < 1) {
    fail("workspace/session/storage proof resources are absent");
  }
  for (const workspace of workspaces) {
    if (
      !positive(workspace.status?.observedGeneration) ||
      workspace.status?.phase !== "Ready" ||
      !["Retain", "Delete"].includes(workspace.spec?.retentionPolicy)
    ) {
      fail(`workspace ${workspace.metadata?.name ?? "unknown"} is not reconciled Ready`);
    }
    const pvcName = workspace.status?.pvcRef?.name;
    const pvc = pvcs.find(({ metadata }) => metadata?.name === pvcName);
    if (!pvc || pvc.status?.phase !== "Bound") fail(`workspace ${workspace.metadata?.name ?? "unknown"} PVC is not Bound`);
    if (
      !Array.isArray(pvc.spec?.accessModes) ||
      pvc.spec.accessModes.length !== 1 ||
      pvc.spec.accessModes[0] !== "ReadWriteMany"
    ) {
      fail(`workspace ${workspace.metadata?.name ?? "unknown"} PVC is not ReadWriteMany`);
    }
    if (typeof pvc.spec?.storageClassName !== "string" || pvc.spec.storageClassName.length === 0) {
      fail(`workspace ${workspace.metadata?.name ?? "unknown"} PVC has no StorageClass`);
    }
  }
  for (const session of sessions) {
    if (!positive(session.status?.observedGeneration) || session.status?.phase !== "Running") {
      fail(`session ${session.metadata?.name ?? "unknown"} is not reconciled Running`);
    }
    if (!workspaces.some(({ metadata }) => metadata?.name === session.spec?.workspaceRef)) {
      fail(`session ${session.metadata?.name ?? "unknown"} references an unknown workspace`);
    }
  }

  const pods = list(snapshot, "pods");
  const sessionPods = pods.filter(({ metadata }) => metadata?.labels?.["cluster.t4.dev/session"]);
  if (sessionPods.length < 1) fail("no durable session pod was observed");
  for (const pod of sessionPods) {
    if (pod.status?.phase !== "Running" || FORBIDDEN_SESSION_NODES.has(pod.spec?.nodeName)) {
      fail(`durable session placement is invalid for ${pod.metadata?.name ?? "unknown"}`);
    }
  }

  const services = list(snapshot, "services");
  const serverService = named(services, "cluster-server", "cluster-server Service");
  const ports = new Map((serverService.spec?.ports ?? []).map(({ name, port }) => [name, port]));
  if (ports.get("omp-app") !== 8080 || ports.get("admin") !== 9090) {
    fail("cluster-server Service does not expose the fixed public/admin ports");
  }
  return snapshot;
}

export function validateDefaultOffRender(documents) {
  if (!Array.isArray(documents) || documents.length > 512) fail("default-off render was malformed or exceeded its bound");
  const workloads = documents.filter((document) => document && WORKLOAD_KINDS.has(document.kind));
  if (workloads.length > 0) {
    fail(`default-off render created workload ${workloads[0].kind}/${workloads[0].metadata?.name ?? "unknown"}`);
  }
  return { clusterOperatorEnabled: false, workloadCount: 0 };
}

export function summarizeClusterSnapshot(snapshot) {
  validateClusterSnapshot(snapshot);
  const deployments = list(snapshot, "deployments");
  const lease = named(list(snapshot, "leases"), "controller", "controller leader Lease");
  const workspaces = list(snapshot, "t4workspaces");
  const sessions = list(snapshot, "t4sessions");
  const pvcs = list(snapshot, "persistentvolumeclaims");
  const allPods = list(snapshot, "pods");
  const pods = allPods.filter(({ metadata }) => metadata?.labels?.["cluster.t4.dev/session"]);
  return {
    schemaVersion: "t4-cluster-readonly-snapshot/1",
    observedAt: new Date().toISOString(),
    deployments: deployments.map(({ metadata, spec, status }) => ({
      name: metadata.name,
      replicas: spec.replicas,
      availableReplicas: status.availableReplicas,
      observedGeneration: status.observedGeneration,
    })),
    leader: { lease: lease.metadata.name, holderIdentity: lease.spec.holderIdentity, renewTime: lease.spec.renewTime },
    crds: list(snapshot, "customresourcedefinitions").map(({ spec }) => `${spec.names.plural}.${spec.group}/v1alpha1`),
    workspaces: workspaces.map(({ metadata, status }) => ({ name: metadata.name, phase: status.phase, pvc: status.pvcRef.name })),
    sessions: sessions.map(({ metadata, status }) => ({ name: metadata.name, phase: status.phase })),
    storage: pvcs.map(({ metadata, spec, status }) => ({
      name: metadata.name,
      storageClassName: spec.storageClassName,
      accessModes: spec.accessModes,
      phase: status.phase,
      capacity: status.capacity?.storage ?? "unknown",
    })),
    placements: pods.map(({ metadata, spec }) => ({ name: metadata.name, node: spec.nodeName })),
    images: allPods.flatMap(({ metadata, status }) =>
      (status?.containerStatuses ?? []).map(({ name, image, imageID }) => ({
        pod: metadata.name,
        container: name,
        image,
        imageID,
      })),
    ),
  };
}
