import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  OBSERVATION_SYSTEMS,
  PROOF_SCENARIOS,
  createFileEvidence,
  redactFrame,
  validateImagePublicationManifest,
  validateProofManifest,
} from "./proof-contract.mjs";

const repoRoot = resolve(import.meta.dirname, "../..");
const proofRoot = resolve(repoRoot, "artifacts/cluster-proof");
const MAX_HTTP_BYTES = 2 * 1024 * 1024;
const MAX_LOCAL_ARTIFACTS = 32;
const SCENARIO_ASSERTION = /^[a-z0-9][a-z0-9._-]{0,127}$/u;

function requiredEnvironment(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function woodpeckerIdentity() {
  const url = requiredEnvironment("CI_PIPELINE_URL");
  const match = new URL(url).pathname.match(/\/repos\/([1-9][0-9]*)\/pipeline\/([1-9][0-9]*)\/?$/u);
  const pipelineNumber = Number(requiredEnvironment("CI_PIPELINE_NUMBER"));
  if (!match || !Number.isSafeInteger(pipelineNumber) || pipelineNumber <= 0) {
    throw new Error("Woodpecker pipeline URL/number identity is invalid");
  }
  return {
    repositoryId: Number(match[1]),
    pipelineId: Number(match[2]),
    pipelineNumber,
    url,
  };
}

async function boundedFetchJson(url, label) {
  const response = await fetch(url, {
    headers: { Accept: "application/json", "User-Agent": "t4-cluster-proof/1" },
    redirect: "error",
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`${label} returned HTTP ${response.status}`);
  const declaredLength = Number(response.headers.get("content-length") ?? 0);
  if (declaredLength > MAX_HTTP_BYTES) throw new Error(`${label} exceeded its byte bound`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length === 0 || bytes.length > MAX_HTTP_BYTES) throw new Error(`${label} was empty or exceeded its byte bound`);
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    throw new Error(`${label} was not valid JSON`, { cause: error });
  }
}

function exactKeys(value, keys, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  const expected = new Set(keys);
  for (const key of Object.keys(value)) {
    if (!expected.has(key)) throw new Error(`${label} has unexpected field ${key}`);
  }
  for (const key of keys) {
    if (!(key in value)) throw new Error(`${label} is missing ${key}`);
  }
}

function utcTimestamp(value, label) {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u.test(value) ||
    !Number.isFinite(Date.parse(value))
  ) {
    throw new Error(`${label} must be a UTC RFC 3339 timestamp`);
  }
  return value;
}

async function scenarioEntries() {
  const directory = resolve(proofRoot, "scenarios");
  const entries = [];
  for (const id of PROOF_SCENARIOS) {
    const path = resolve(directory, `${id}.json`);
    const record = JSON.parse(await readFile(path, "utf8"));
    exactKeys(record, ["schemaVersion", "id", "status", "observedAt", "assertions"], `scenario ${id}`);
    if (
      record.schemaVersion !== "t4-cluster-scenario/1" ||
      record.id !== id ||
      record.status !== "passed" ||
      !Array.isArray(record.assertions) ||
      record.assertions.length < 1 ||
      record.assertions.length > 64 ||
      new Set(record.assertions).size !== record.assertions.length ||
      record.assertions.some((assertion) => !SCENARIO_ASSERTION.test(assertion))
    ) {
      throw new Error(`scenario ${id} did not contain an exact passing contract result`);
    }
    entries.push({
      id,
      status: "passed",
      observedAt: utcTimestamp(record.observedAt, `scenario ${id}.observedAt`),
      assertions: record.assertions,
      evidence: [await createFileEvidence(path, { artifactRoot: repoRoot })],
    });
  }
  return entries;
}

function safeSummary(value, label, depth = 0) {
  if (depth > 8) throw new Error(`${label} exceeded its depth bound`);
  if (value === null || typeof value === "boolean" || typeof value === "number") return;
  if (typeof value === "string") {
    if (value.length > 2048) throw new Error(`${label} contained an oversized string`);
    return;
  }
  if (Array.isArray(value)) {
    if (value.length > 128) throw new Error(`${label} exceeded its item bound`);
    value.forEach((item, index) => safeSummary(item, `${label}[${index}]`, depth + 1));
    return;
  }
  if (!value || typeof value !== "object") throw new Error(`${label} contained an unsupported value`);
  const entries = Object.entries(value);
  if (entries.length > 128) throw new Error(`${label} exceeded its field bound`);
  for (const [key, item] of entries) {
    if (/authorization|cookie|credential|password|prompt|secret|token|transcript/iu.test(key)) {
      throw new Error(`${label} contained sensitive field ${key}`);
    }
    safeSummary(item, `${label}.${key}`, depth + 1);
  }
}

async function observationEntries() {
  const metadata = await boundedFetchJson(
    requiredEnvironment("T4_OBSERVABILITY_MANIFEST_URL"),
    "observability manifest",
  );
  exactKeys(metadata, ["schemaVersion", "sourceCommit", "observations"], "observability manifest");
  if (
    metadata.schemaVersion !== "t4-cluster-observations/1" ||
    metadata.sourceCommit !== requiredEnvironment("CI_COMMIT_SHA") ||
    !Array.isArray(metadata.observations) ||
    metadata.observations.length !== OBSERVATION_SYSTEMS.length
  ) {
    throw new Error("observability manifest identity or coverage is invalid");
  }
  const bySystem = new Map();
  for (const observation of metadata.observations) {
    exactKeys(observation, ["system", "observedAt", "url", "ids", "evidenceUrl"], "observation metadata");
    if (!OBSERVATION_SYSTEMS.includes(observation.system) || bySystem.has(observation.system)) {
      throw new Error("observability manifest contains an unknown or duplicate system");
    }
    bySystem.set(observation.system, observation);
  }

  const directory = resolve(proofRoot, "observations");
  await mkdir(directory, { recursive: true });
  const entries = [];
  for (const system of OBSERVATION_SYSTEMS) {
    const metadataEntry = bySystem.get(system);
    if (!metadataEntry) throw new Error(`observability manifest is missing ${system}`);
    let path;
    if (system === "kubernetes") {
      path = resolve(directory, "kubernetes.json");
    } else if (system === "woodpecker") {
      path = resolve(directory, "woodpecker.json");
      await writeFile(
        path,
        `${JSON.stringify(
          {
            schemaVersion: "t4-woodpecker-observation/1",
            observedAt: new Date().toISOString(),
            ...woodpeckerIdentity(),
          },
          null,
          2,
        )}\n`,
        { mode: 0o600 },
      );
    } else {
      const payload = await boundedFetchJson(metadataEntry.evidenceUrl, `${system} evidence`);
      exactKeys(payload, ["schemaVersion", "system", "observedAt", "redacted", "summary"], `${system} evidence`);
      if (
        payload.schemaVersion !== "t4-cluster-observation/1" ||
        payload.system !== system ||
        payload.redacted !== true
      ) {
        throw new Error(`${system} evidence is not an exact redacted observation`);
      }
      utcTimestamp(payload.observedAt, `${system} evidence observedAt`);
      safeSummary(payload.summary, `${system} evidence summary`);
      path = resolve(directory, `${system}.json`);
      await writeFile(path, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
    }
    entries.push({
      system,
      observedAt: utcTimestamp(metadataEntry.observedAt, `${system}.observedAt`),
      url: metadataEntry.url,
      ids: metadataEntry.ids,
      evidence: await createFileEvidence(path, { artifactRoot: repoRoot }),
    });
  }
  return entries;
}

async function localArtifacts(kind, extensions) {
  const directory = resolve(proofRoot, kind);
  const names = (await readdir(directory)).filter((name) => extensions.some((extension) => name.endsWith(extension))).sort();
  if (names.length < 1 || names.length > MAX_LOCAL_ARTIFACTS) {
    throw new Error(`${kind} artifact count is outside its bound`);
  }
  const results = [];
  for (const name of names) {
    const path = resolve(directory, name);
    if (kind === "frames") {
      const parsed = JSON.parse(await readFile(path, "utf8"));
      const frames = Array.isArray(parsed) ? parsed : [parsed];
      if (frames.length < 1 || frames.length > 256) throw new Error(`${name} frame count is outside its bound`);
      for (const frame of frames) {
        if (JSON.stringify(redactFrame(frame)) !== JSON.stringify(frame)) {
          throw new Error(`${name} contains unredacted authority-sensitive frame state`);
        }
      }
    }
    const viewport = /mobile/iu.test(name) ? "mobile" : /desktop/iu.test(name) ? "desktop" : undefined;
    results.push({
      ...(await createFileEvidence(path, { artifactRoot: repoRoot })),
      redacted: true,
      ...(viewport ? { viewport } : {}),
    });
  }
  return results;
}

async function verifyLiveImageDigests(images) {
  const snapshot = JSON.parse(
    await readFile(resolve(proofRoot, "observations/kubernetes.json"), "utf8"),
  );
  if (
    snapshot?.schemaVersion !== "t4-cluster-readonly-snapshot/1" ||
    !Array.isArray(snapshot.images) ||
    snapshot.images.length > 64
  ) {
    throw new Error("Kubernetes observation has no bounded live image identity");
  }
  for (const image of images) {
    const suffix = image.repository.slice(image.repository.lastIndexOf("/") + 1);
    const match = snapshot.images.find(
      ({ image: declaredImage, imageID }) =>
        typeof declaredImage === "string" &&
        (declaredImage.includes(`/${suffix}:`) || declaredImage.includes(`/${suffix}@`)) &&
        typeof imageID === "string" &&
        imageID.endsWith(`@${image.digest}`),
    );
    if (!match) {
      throw new Error(`live Kubernetes pods do not run published ${image.component} digest ${image.digest}`);
    }
  }
}

export async function assembleProofManifest() {
  const imageManifest = validateImagePublicationManifest(
    JSON.parse(await readFile(resolve(proofRoot, "image-publication.json"), "utf8")),
  );
  if (imageManifest.source.commit !== requiredEnvironment("CI_COMMIT_SHA")) {
    throw new Error("image publication manifest does not match this source commit");
  }
  await verifyLiveImageDigests(imageManifest.images);
  const source = {
    repository: requiredEnvironment("CI_REPO"),
    commit: requiredEnvironment("CI_COMMIT_SHA"),
    woodpecker: woodpeckerIdentity(),
  };
  const manifest = {
    schemaVersion: "t4-cluster-proof/1",
    source,
    images: imageManifest.images,
    scenarios: await scenarioEntries(),
    observations: await observationEntries(),
    artifacts: {
      frames: await localArtifacts("frames", [".json"]),
      screenshots: await localArtifacts("screenshots", [".png", ".webp"]),
      videos: await localArtifacts("videos", [".webm"]),
    },
  };
  return validateProofManifest(manifest);
}

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) {
  try {
    const manifest = await assembleProofManifest();
    const outputPath = resolve(proofRoot, "manifest.json");
    const temporaryPath = `${outputPath}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
    await rename(temporaryPath, outputPath);
    console.log(`Wrote ${outputPath}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
