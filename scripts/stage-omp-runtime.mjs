#!/usr/bin/env node

import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { chmod, copyFile, mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { basename, isAbsolute, join, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

const repoRoot = resolve(import.meta.dirname, "..");
const matrix = JSON.parse(await readFile(join(repoRoot, "compat", "omp-app-matrix.json"), "utf8"));
const option = (name) => {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
};
const platform = option("platform") ?? process.platform;
const arch = option("arch") ?? process.arch;
const key = `${platform}-${arch}`;
const runtimeKind = option("runtime") ?? "verified";
if (runtimeKind !== "verified" && runtimeKind !== "official") {
  throw new Error("--runtime must be official or verified");
}
const runtime = runtimeKind === "official" ? matrix.officialRuntime : matrix.verifiedRuntime;
const artifact = runtime?.artifacts?.[key];
if (!artifact || !/^[a-z0-9][a-z0-9._-]{1,80}$/u.test(artifact.name) || !/^[0-9a-f]{64}$/u.test(artifact.sha256)) {
  throw new Error(`compat/omp-app-matrix.json has no valid ${runtimeKind} ${key} runtime artifact`);
}
const outputRoot = join(repoRoot, ".artifacts", runtimeKind === "official" ? "omp-runtime-official" : "omp-runtime");
const output = join(outputRoot, "omp");
const temporary = `${output}.partial-${process.pid}`;
const url = `${runtime.sourceRepository}/releases/download/${runtime.sourceTag}/${artifact.name}`;
const localRuntime = process.env.T4_STAGE_OMP_RUNTIME;
const localRuntimeTag = process.env.T4_STAGE_OMP_RUNTIME_TAG;
const allowLocalRuntime = process.env.T4_ALLOW_LOCAL_OMP_RUNTIME === "1";
const localRuntimeTagPattern = /^t4code-[0-9]+\.[0-9]+\.[0-9]+-appserver-[1-9][0-9]*$/u;

async function sha256(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

await mkdir(outputRoot, { recursive: true, mode: 0o700 });
if (localRuntime !== undefined || localRuntimeTag !== undefined) {
  if (!allowLocalRuntime) throw new Error("local OMP runtime staging requires T4_ALLOW_LOCAL_OMP_RUNTIME=1");
  if (runtimeKind !== "verified") throw new Error("local OMP runtime staging is only valid for --runtime verified");
  if (typeof localRuntime !== "string" || localRuntime.length === 0 || !isAbsolute(localRuntime)) {
    throw new Error("T4_STAGE_OMP_RUNTIME must be an absolute executable path");
  }
  if (typeof localRuntimeTag !== "string" || !localRuntimeTagPattern.test(localRuntimeTag)) {
    throw new Error("T4_STAGE_OMP_RUNTIME_TAG must be a t4code-x.y.z-appserver-n tag");
  }
  const source = resolve(localRuntime);
  const sourceStat = await stat(source);
  const sourceSha256 = await sha256(source);
  let current;
  try {
    current = await stat(output);
  } catch {}
  if (!current || current.size !== sourceStat.size || (await sha256(output)) !== sourceSha256) {
    await copyFile(source, temporary);
    await chmod(temporary, 0o755);
    await rename(temporary, output);
  }
  await writeFile(
    join(outputRoot, "manifest.json"),
    `${JSON.stringify({ version: 1, tag: localRuntimeTag, platform, arch, executable: basename(output), size: sourceStat.size, sha256: sourceSha256 }, null, 2)}\n`,
    { mode: 0o600 },
  );
  console.log(`staged local verified ${localRuntimeTag} ${key} runtime`);
} else {
  let current;
  try {
    current = await stat(output);
  } catch {}
  if (!current || current.size !== artifact.size || (await sha256(output)) !== artifact.sha256) {
    const response = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(120_000) });
    if (!response.ok || !response.body) throw new Error(`runtime download failed with HTTP ${response.status}`);
    await pipeline(Readable.fromWeb(response.body), createWriteStream(temporary, { flags: "wx", mode: 0o600 }));
    const downloaded = await stat(temporary);
    if (downloaded.size !== artifact.size || (await sha256(temporary)) !== artifact.sha256) {
      await unlink(temporary).catch(() => {});
      throw new Error("downloaded OMP runtime does not match the pinned size and SHA-256 digest");
    }
    await chmod(temporary, 0o755);
    await rename(temporary, output);
  }
  await writeFile(
    join(outputRoot, "manifest.json"),
    `${JSON.stringify({ version: 1, tag: runtime.sourceTag, platform, arch, executable: basename(output), size: artifact.size, sha256: artifact.sha256 }, null, 2)}\n`,
    { mode: 0o600 },
  );
  console.log(`staged ${runtimeKind} ${runtime.sourceTag} ${key} runtime`);
}
