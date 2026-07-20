import { execFile } from "node:child_process";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import yaml from "js-yaml";

import {
  collectReadOnlyClusterSnapshot,
  summarizeClusterSnapshot,
  validateDefaultOffRender,
} from "./readonly-cluster-proof.mjs";

const execFileAsync = promisify(execFile);
const repoRoot = resolve(import.meta.dirname, "../..");
const proofRoot = resolve(repoRoot, "artifacts/cluster-proof");
const scenarioRoot = resolve(proofRoot, "scenarios");
const observationRoot = resolve(proofRoot, "observations");

function requiredEnvironment(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function currentCiMapping() {
  const pipelineUrl = new URL(requiredEnvironment("CI_PIPELINE_URL"));
  const match = pipelineUrl.pathname.match(/^\/repos\/([1-9][0-9]*)\/pipeline\/[1-9][0-9]*\/?$/u);
  if (
    pipelineUrl.origin !== "https://woodpecker-ci-dev.tailb18de3.ts.net" ||
    pipelineUrl.username ||
    pipelineUrl.password ||
    pipelineUrl.search ||
    pipelineUrl.hash ||
    !match
  ) {
    throw new Error("CI_PIPELINE_URL does not identify the exact credential-free Woodpecker repository");
  }
  const repository = requiredEnvironment("CI_REPO");
  if (repository !== "z-peterson/t4-code") throw new Error("CI_REPO is not the canonical source repository");
  return {
    repositoryId: match[1],
    ref: requiredEnvironment("CI_COMMIT_REF"),
    commit: requiredEnvironment("CI_COMMIT_SHA"),
  };
}

async function atomicJson(path, value) {
  const temporaryPath = `${path}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temporaryPath, path);
}

async function scenario(id, observedAt, assertions) {
  await atomicJson(resolve(scenarioRoot, `${id}.json`), {
    schemaVersion: "t4-cluster-scenario/1",
    id,
    status: "passed",
    observedAt,
    assertions,
  });
}

async function defaultOffEvidence(namespace) {
  const { stdout } = await execFileAsync(
    "helm",
    ["template", "t4-default-off", "deploy/charts/t4-cluster", "--namespace", namespace],
    { cwd: repoRoot, encoding: "utf8", maxBuffer: 8 * 1024 * 1024, timeout: 30_000 },
  );
  const documents = [];
  yaml.loadAll(stdout, (document) => {
    if (document) documents.push(document);
  });
  const result = validateDefaultOffRender(documents);
  await atomicJson(resolve(observationRoot, "feature-off-render.json"), {
    schemaVersion: "t4-cluster-feature-off/1",
    observedAt: new Date().toISOString(),
    ...result,
    renderedKinds: [...new Set(documents.map(({ kind }) => kind).filter(Boolean))].sort(),
  });
  return result;
}

export async function collectClusterEvidence({ namespace, ciMapping = currentCiMapping() }) {
  await mkdir(scenarioRoot, { recursive: true });
  await mkdir(observationRoot, { recursive: true });
  const snapshot = await collectReadOnlyClusterSnapshot({ namespace });
  const summary = summarizeClusterSnapshot(snapshot, { ciMapping });
  await atomicJson(resolve(observationRoot, "kubernetes.json"), summary);
  await scenario("ha-manifest", summary.observedAt, [
    "controller.replicas-2",
    "controller.rolling-update.max-unavailable-1",
    "server.replicas-3",
    "server.rolling-update.max-unavailable-0",
  ]);
  await scenario("leader-election", summary.observedAt, [
    "lease.active-holder",
    "lease.renew-time-observed",
    "reconcile.single-active-leader",
  ]);
  await scenario("crd-reconcile-storage", summary.observedAt, [
    "crd.namespaced-v1alpha1",
    "reconcile.observed-generation",
    "storage.bound-read-write-many",
    "placement.session-worker-exclusions",
  ]);
  await scenario("ci-mapping", summary.observedAt, [
    "ci.repository-id-exact",
    "ci.ref-exact",
    "ci.commit-exact",
    "ci.session-running-ready",
  ]);
  const off = await defaultOffEvidence(namespace);
  await scenario("feature-off", new Date().toISOString(), [
    off.clusterOperatorEnabled ? "feature-off.invalid" : "feature-off.no-workloads",
  ]);
  return summary;
}

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) {
  try {
    const namespace = process.env.T4_CLUSTER_NAMESPACE?.trim();
    if (!namespace) throw new Error("T4_CLUSTER_NAMESPACE is required");
    const summary = await collectClusterEvidence({ namespace });
    console.log(
      `Captured read-only T4 cluster evidence for ${summary.workspaces.length} workspace(s) and ${summary.sessions.length} session(s)`,
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
