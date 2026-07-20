import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  IMAGE_COMPONENTS,
  createFileEvidence,
  validateImagePublicationManifest,
} from "./proof-contract.mjs";

const repoRoot = resolve(import.meta.dirname, "../..");
const artifactDirectory = resolve(repoRoot, "artifacts/cluster-proof/images");
const outputPath = resolve(repoRoot, "artifacts/cluster-proof/image-publication.json");
const suffixes = {
  controller: "t4-cluster-operator",
  "cluster-server": "t4-cluster-server",
  "session-runtime": "t4-session-runtime",
};

function requiredEnvironment(name, environment = process.env) {
  const value = environment[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function woodpeckerIdentity(environment = process.env) {
  const url = requiredEnvironment("CI_PIPELINE_URL", environment);
  const match = new URL(url).pathname.match(/\/repos\/([1-9][0-9]*)\/pipeline\/([1-9][0-9]*)\/?$/u);
  const pipelineNumber = Number(requiredEnvironment("CI_PIPELINE_NUMBER", environment));
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

async function json(path, label) {
  let value;
  try {
    value = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    throw new Error(`${label} is not valid JSON`, { cause: error });
  }
  return value;
}

function vulnerabilityCounts(report) {
  if (!report || typeof report !== "object" || !Array.isArray(report.Results)) {
    throw new Error("Trivy report is malformed");
  }
  const counts = { critical: 0, high: 0 };
  for (const result of report.Results) {
    if (!Array.isArray(result.Vulnerabilities)) continue;
    for (const vulnerability of result.Vulnerabilities) {
      if (vulnerability?.Severity === "CRITICAL") counts.critical += 1;
      else if (vulnerability?.Severity === "HIGH") counts.high += 1;
    }
  }
  if (counts.critical !== 0 || counts.high !== 0) {
    throw new Error(`Trivy found ${counts.critical} critical and ${counts.high} high vulnerabilities`);
  }
  return counts;
}

function verifyProvenance(jsonLines, digest) {
  const expected = digest.slice("sha256:".length);
  const lines = jsonLines.split("\n").filter(Boolean);
  if (lines.length < 1 || lines.length > 32) throw new Error("provenance attestation count is invalid");
  const statements = [];
  for (const line of lines) {
    const envelope = JSON.parse(line);
    if (envelope?.payloadType !== "application/vnd.in-toto+json" || typeof envelope.payload !== "string") {
      throw new Error("provenance attestation is not an in-toto envelope");
    }
    statements.push(JSON.parse(Buffer.from(envelope.payload, "base64").toString("utf8")));
  }
  const provenance = statements.find(
    (statement) =>
      typeof statement?.predicateType === "string" &&
      statement.predicateType.includes("slsa.dev/provenance") &&
      statement.subject?.some(({ digest: subjectDigest }) => subjectDigest?.sha256 === expected),
  );
  if (!provenance) throw new Error("BuildKit provenance does not bind the published image digest");
}

async function imageEntry(component, commit, registry, project) {
  const digest = (await readFile(resolve(artifactDirectory, `${component}.digest`), "utf8")).trim();
  const repository = `${registry}/${project}/${suffixes[component]}`;
  const sbomPath = resolve(artifactDirectory, `${component}.spdx.json`);
  const provenancePath = resolve(artifactDirectory, `${component}.provenance.jsonl`);
  const vulnerabilityPath = resolve(artifactDirectory, `${component}.trivy.json`);
  const sbom = await json(sbomPath, `${component} SBOM`);
  if (typeof sbom.spdxVersion !== "string" || !sbom.spdxVersion.startsWith("SPDX-")) {
    throw new Error(`${component} SBOM is not SPDX JSON`);
  }
  verifyProvenance(await readFile(provenancePath, "utf8"), digest);
  const counts = vulnerabilityCounts(await json(vulnerabilityPath, `${component} vulnerability report`));
  return {
    component,
    repository,
    tag: commit,
    digest,
    reference: `${repository}@${digest}`,
    sbom: await createFileEvidence(sbomPath, { artifactRoot: repoRoot }),
    provenance: await createFileEvidence(provenancePath, { artifactRoot: repoRoot }),
    vulnerability: {
      ...(await createFileEvidence(vulnerabilityPath, { artifactRoot: repoRoot })),
      scanner: "trivy",
      ...counts,
    },
  };
}

export async function assembleImagePublicationManifest(environment = process.env) {
  const commit = requiredEnvironment("CI_COMMIT_SHA", environment);
  const registry = requiredEnvironment("HARBOR_REGISTRY", environment).replace(/\/$/u, "");
  const project = requiredEnvironment("HARBOR_PROJECT", environment).replace(/^\/+|\/+$/gu, "");
  const manifest = {
    schemaVersion: "t4-cluster-images/1",
    source: {
      repository: requiredEnvironment("CI_REPO", environment),
      commit,
      woodpecker: woodpeckerIdentity(environment),
    },
    images: await Promise.all(
      IMAGE_COMPONENTS.map((component) => imageEntry(component, commit, registry, project)),
    ),
  };
  return validateImagePublicationManifest(manifest);
}

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) {
  const manifest = await assembleImagePublicationManifest();
  await mkdir(resolve(repoRoot, "artifacts/cluster-proof"), { recursive: true });
  const temporaryPath = `${outputPath}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  await rename(temporaryPath, outputPath);
  console.log(`Wrote ${outputPath}`);
}
