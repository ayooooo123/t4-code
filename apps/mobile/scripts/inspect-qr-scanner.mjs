import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
// apkanalyzer's class listing includes member rows; this APK is ~11 MiB. Keep
// a hard ceiling above that known-good size and fail rather than truncate it.
const MAX_COMMAND_OUTPUT = 16 * 1024 * 1024;
const MAX_COMMAND_MS = 120_000;
const CAMERA_ARTIFACTS = ["camera-camera2", "camera-core", "camera-lifecycle", "camera-view"];
const REQUIRED_MODELS = [
  "barcode_ssd_mobilenet_v1_dmp25_quant.tflite",
  "oned_auto_regressor_mobile.tflite",
  "oned_feature_extractor_mobile.tflite",
];

function fail() {
  throw new Error("QR scanner inspection failed");
}

function requireText(value) {
  if (typeof value !== "string" || value.trim().length === 0) fail();
  return value;
}

function stripComments(source) {
  let result = "";
  let state = "code";
  let escaped = false;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    const next = source[index + 1];
    if (state === "line-comment") {
      if (character === "\n") {
        state = "code";
        result += character;
      } else result += " ";
      continue;
    }
    if (state === "block-comment") {
      if (character === "*" && next === "/") {
        result += "  ";
        index += 1;
        state = "code";
      } else result += character === "\n" ? "\n" : " ";
      continue;
    }
    if (state === "single-quote" || state === "double-quote") {
      result += character;
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (
        (state === "single-quote" && character === "'") ||
        (state === "double-quote" && character === '"')
      ) state = "code";
      continue;
    }
    if (character === "/" && next === "/") {
      result += "  ";
      index += 1;
      state = "line-comment";
    } else if (character === "/" && next === "*") {
      result += "  ";
      index += 1;
      state = "block-comment";
    } else {
      result += character;
      if (character === "'") state = "single-quote";
      else if (character === '"') state = "double-quote";
    }
  }
  return result;
}

function stripQuotedLiterals(source) {
  let result = "";
  let quote = null;
  let escaped = false;
  for (const character of source) {
    if (quote === null) {
      if (character === "'" || character === '"') {
        quote = character;
        result += " ";
      } else result += character;
      continue;
    }
    result += character === "\n" ? "\n" : " ";
    if (escaped) escaped = false;
    else if (character === "\\") escaped = true;
    else if (character === quote) quote = null;
  }
  return result;
}

function directCoordinates(gradle, group, artifact) {
  const escaped = `${group}:${artifact}`.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const stringNotation = [...gradle.matchAll(new RegExp(`(?:implementation|api|compileOnly|runtimeOnly)\\s*(?:\\(|\\s)[\\s'\"]*${escaped}:([^'\"\\s)]+)`, "gu"))]
    .map((match) => match[1]);
  const mapNotation = dependencyDeclarations(gradle).flatMap((declaration) => {
    const declaredGroup = gradleMapAttribute(declaration, "group");
    const declaredName = gradleMapAttribute(declaration, "name");
    const version = gradleMapAttribute(declaration, "version");
    return declaredGroup === group && declaredName === artifact && version !== null ? [version] : [];
  });
  return [...stringNotation, ...mapNotation];
}

function dependencyDeclarations(gradle) {
  const declarations = [];
  const lines = gradle.split(/\r?\n/u);
  for (let index = 0; index < lines.length; index += 1) {
    if (!/^\s*(?:implementation|api|compileOnly|runtimeOnly)\b/u.test(lines[index])) continue;
    let declaration = lines[index];
    const opening = (declaration.match(/\(/gu) ?? []).length;
    let closing = (declaration.match(/\)/gu) ?? []).length;
    for (let cursor = index + 1; opening > closing && cursor < lines.length; cursor += 1) {
      declaration += `\n${lines[cursor]}`;
      closing += (lines[cursor].match(/\)/gu) ?? []).length;
      index = cursor;
    }
    declarations.push(declaration);
  }
  return declarations;
}

function gradleMapAttribute(declaration, name) {
  const match = declaration.match(new RegExp(`\\b${name}\\s*(?::|=)\\s*(['\"])([^'\"]+)\\1`, "u"));
  return match?.[2] ?? null;
}

function rootResolvedVersions(dependencies, group, artifact) {
  const coordinate = `${group}:${artifact}`.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return [...dependencies.matchAll(new RegExp(
    `^(?:\\+---|\\\\---)\\s+${coordinate}:([^\\s]+)(?:\\s+->\\s+([^\\s]+))?`,
    "gmu",
  ))].map((match) => match[2] ?? match[1]);
}

function hasDynamicBarcodeMetadata(manifest) {
  for (const match of manifest.matchAll(/<meta-data\b[^>]*>/giu)) {
    const tag = match[0];
    const name = tag.match(/\bandroid:name\s*=\s*(['"])(.*?)\1/iu)?.[2];
    if (name !== "com.google.mlkit.vision.DEPENDENCIES") continue;
    const value = tag.match(/\bandroid:value\s*=\s*(['"])(.*?)\1/iu)?.[2];
    if (value?.split(/[\s,]+/u).some((entry) => entry === "barcode" || entry === "barcode_ui")) {
      return true;
    }
  }
  return false;
}

export function parseQrScannerEvidence(input) {
  const dependencies = requireText(input.dependencies);
  const appGradle = stripComments(requireText(input.appGradle));
  const manifest = requireText(input.manifest);
  const apkFiles = requireText(input.apkFiles);
  const dexListing = requireText(input.dexListing);
  const activitySource = stripQuotedLiterals(stripComments(requireText(input.activitySource)));

  if (!dependencies.includes("BUILD SUCCESSFUL")) fail();
  for (const artifact of CAMERA_ARTIFACTS) {
    const direct = directCoordinates(appGradle, "androidx.camera", artifact);
    if (direct.length !== 1 || direct[0] !== "1.5.2") fail();
    const resolved = rootResolvedVersions(dependencies, "androidx.camera", artifact);
    if (resolved.length !== 1 || resolved[0] !== "1.5.2") fail();
  }
  const bundled = directCoordinates(appGradle, "com.google.mlkit", "barcode-scanning");
  if (bundled.length !== 1 || bundled[0] !== "17.3.0") fail();
  const bundledResolved = rootResolvedVersions(dependencies, "com.google.mlkit", "barcode-scanning");
  if (bundledResolved.length !== 1 || bundledResolved[0] !== "17.3.0") fail();

  if (
    directCoordinates(appGradle, "com.google.android.gms", "play-services-code-scanner").length !== 0 ||
    rootResolvedVersions(dependencies, "com.google.android.gms", "play-services-code-scanner").length !== 0
  ) fail();
  if (
    directCoordinates(appGradle, "com.google.android.gms", "play-services-mlkit-barcode-scanning").length !== 0 ||
    rootResolvedVersions(dependencies, "com.google.android.gms", "play-services-mlkit-barcode-scanning").length !== 0
  ) fail();
  if (/GmsBarcodeScanning/u.test(activitySource) || /GmsBarcodeScanning/u.test(dexListing)) fail();
  if (!/com\.google\.mlkit\.vision\.barcode\.BarcodeScanner(?:\s|$)/mu.test(dexListing)) fail();
  if (!/BarcodeScanning\.getClient\s*\(/u.test(activitySource)) fail();
  if (hasDynamicBarcodeMetadata(manifest)) fail();

  const modelCount = REQUIRED_MODELS.filter((model) =>
    apkFiles.includes(`assets/mlkit_barcode_models/${model}`)
  ).length;
  if (modelCount !== REQUIRED_MODELS.length) fail();
  const nativeDecoderAbis = [...apkFiles.matchAll(/(?:^|\s|\/)lib\/([^/\s]+)\/libbarhopper_v3\.so(?:\s|$)/gmu)]
    .map((match) => match[1])
    .filter((value, index, all) => all.indexOf(value) === index)
    .sort();
  if (nativeDecoderAbis.length === 0) fail();

  return {
    cameraX: true,
    bundledDecoder: true,
    playServicesScannerPath: false,
    modelCount,
    nativeDecoderAbis,
  };
}

async function defaultRunCommand(command, args, options = {}) {
  try {
    const result = await execFileAsync(command, args, {
      cwd: options.cwd,
      env: options.env,
      encoding: "utf8",
      maxBuffer: MAX_COMMAND_OUTPUT,
      timeout: MAX_COMMAND_MS,
    });
    return { status: 0, stdout: result.stdout, stderr: result.stderr, truncated: false };
  } catch {
    return { status: 1, stdout: "", stderr: "", truncated: false };
  }
}

function checkedOutput(result) {
  if (
    result === null || typeof result !== "object" || result.status !== 0 || result.truncated !== false ||
    typeof result.stdout !== "string" || result.stdout.trim().length === 0 || result.stdout.length > MAX_COMMAND_OUTPUT
  ) fail();
  return result.stdout;
}

function withDeadline(operation, timeoutMs) {
  let timer;
  return Promise.race([
    Promise.resolve().then(operation),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("deadline exceeded")), timeoutMs);
    }),
  ]).finally(() => clearTimeout(timer));
}

async function checkedCommand(runCommand, command, args, options, timeoutMs) {
  try {
    return checkedOutput(await withDeadline(
      () => runCommand(command, args, options),
      timeoutMs,
    ));
  } catch {
    fail();
  }
}

export async function inspectQrScanner({
  apkPath,
  mobileRoot = resolve(import.meta.dirname, ".."),
  sdkRoot = process.env.ANDROID_SDK_ROOT ?? process.env.ANDROID_HOME ?? resolve(homedir(), "Library/Android/sdk"),
  runCommand = defaultRunCommand,
  commandTimeoutMs = MAX_COMMAND_MS,
  readText = (path) => readFile(path, "utf8"),
} = {}) {
  if (
    typeof apkPath !== "string" || apkPath.length === 0 ||
    !Number.isInteger(commandTimeoutMs) || commandTimeoutMs < 1 || commandTimeoutMs > MAX_COMMAND_MS
  ) fail();
  const gradlew = resolve(mobileRoot, "android/gradlew");
  const androidRoot = resolve(mobileRoot, "android");
  const apkanalyzer = resolve(sdkRoot, "cmdline-tools/latest/bin/apkanalyzer");
  const appGradlePath = resolve(mobileRoot, "android/app/build.gradle");
  const activityPath = resolve(
    mobileRoot,
    "android/app/src/main/java/com/lycaonsolutions/t4code/T4QrScannerActivity.java",
  );

  let appGradle;
  let activitySource;
  try {
    [appGradle, activitySource] = await Promise.all([readText(appGradlePath), readText(activityPath)]);
  } catch {
    fail();
  }
  const gradleEnvironment = {
    ...process.env,
    ANDROID_HOME: sdkRoot,
    ANDROID_SDK_ROOT: sdkRoot,
  };
  const dependencies = await checkedCommand(
    runCommand,
    gradlew,
    ["--no-daemon", ":app:dependencies", "--configuration", "debugRuntimeClasspath"],
    { cwd: androidRoot, env: gradleEnvironment },
    commandTimeoutMs,
  );
  const manifest = await checkedCommand(
    runCommand, apkanalyzer, ["manifest", "print", apkPath], undefined, commandTimeoutMs,
  );
  const apkFiles = await checkedCommand(
    runCommand, apkanalyzer, ["files", "list", apkPath], undefined, commandTimeoutMs,
  );
  const dexListing = await checkedCommand(
    runCommand,
    apkanalyzer,
    ["dex", "packages", "--defined-only", apkPath],
    undefined,
    commandTimeoutMs,
  );
  return parseQrScannerEvidence({ dependencies, appGradle, manifest, apkFiles, dexListing, activitySource });
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  const args = process.argv.slice(2);
  if (args.length !== 1) {
    console.error("usage: node inspect-qr-scanner.mjs <debug.apk>");
    process.exitCode = 1;
  } else {
    try {
      console.log(JSON.stringify(await inspectQrScanner({ apkPath: resolve(args[0]) })));
    } catch {
      console.error("QR scanner inspection failed");
      process.exitCode = 1;
    }
  }
}
