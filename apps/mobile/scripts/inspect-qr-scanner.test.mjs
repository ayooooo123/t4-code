import assert from "node:assert/strict";
import test from "node:test";

import { inspectQrScanner, parseQrScannerEvidence } from "./inspect-qr-scanner.mjs";

const cameraCoordinates = ["camera-camera2", "camera-core", "camera-lifecycle", "camera-view"]
  .map((name) => `+--- androidx.camera:${name}:1.5.2`)
  .join("\n");
const goodDependencies = `${cameraCoordinates}\n\\--- com.google.mlkit:barcode-scanning:17.3.0\nBUILD SUCCESSFUL`;
const goodGradle = `dependencies {
  implementation 'androidx.camera:camera-camera2:1.5.2'
  implementation 'androidx.camera:camera-core:1.5.2'
  implementation 'androidx.camera:camera-lifecycle:1.5.2'
  implementation 'androidx.camera:camera-view:1.5.2'
  implementation 'com.google.mlkit:barcode-scanning:17.3.0'
}`;
const goodFiles = [
  "assets/mlkit_barcode_models/barcode_ssd_mobilenet_v1_dmp25_quant.tflite",
  "assets/mlkit_barcode_models/oned_auto_regressor_mobile.tflite",
  "assets/mlkit_barcode_models/oned_feature_extractor_mobile.tflite",
  "lib/arm64-v8a/libbarhopper_v3.so",
].join("\n");
const goodSource = "BarcodeScanner scanner = BarcodeScanning.getClient(options);";

function evidence(overrides = {}) {
  return {
    dependencies: goodDependencies,
    appGradle: goodGradle,
    manifest: "<manifest><application /></manifest>",
    apkFiles: goodFiles,
    dexListing: "C com.google.mlkit.vision.barcode.BarcodeScanner",
    activitySource: goodSource,
    ...overrides,
  };
}

test("accepts pinned CameraX and the bundled ML Kit decoder without treating its transitive implementation as direct", () => {
  const result = parseQrScannerEvidence(evidence({
    dependencies: `${goodDependencies}\n|    +--- com.google.android.gms:play-services-mlkit-barcode-scanning:18.3.1`,
  }));

  assert.deepEqual(result, {
    cameraX: true,
    bundledDecoder: true,
    playServicesScannerPath: false,
    modelCount: 3,
    nativeDecoderAbis: ["arm64-v8a"],
  });
});

for (const coordinate of [
  "androidx.camera:camera-camera2:1.5.2",
  "androidx.camera:camera-core:1.5.2",
  "androidx.camera:camera-lifecycle:1.5.2",
  "androidx.camera:camera-view:1.5.2",
  "com.google.mlkit:barcode-scanning:17.3.0",
]) {
  test(`rejects a resolved version override for ${coordinate}`, () => {
    assert.throws(() => parseQrScannerEvidence(evidence({
      dependencies: goodDependencies.replace(coordinate, `${coordinate} -> 99.0.0`),
    })), /QR scanner inspection failed/);
  });
}

test("ignores forbidden Gradle declarations inside line and block comments", () => {
  const result = parseQrScannerEvidence(evidence({
    appGradle: `${goodGradle}
// implementation 'com.google.android.gms:play-services-code-scanner:16.1.0'
/* implementation group: 'com.google.android.gms', name: 'play-services-mlkit-barcode-scanning', version: '18.3.1' */`,
  }));
  assert.equal(result.playServicesScannerPath, false);
});

test("does not accept a commented-only BarcodeScanning call site", () => {
  assert.throws(() => parseQrScannerEvidence(evidence({
    activitySource: `// BarcodeScanning.getClient(options);
/* BarcodeScanning.getClient(options); */
BarcodeScanner scanner;`,
  })), /QR scanner inspection failed/);
});

test("ignores commented GmsBarcodeScanning call sites", () => {
  assert.equal(parseQrScannerEvidence(evidence({
    activitySource: `${goodSource}
// GmsBarcodeScanning.getClient(this);
/* GmsBarcodeScanning.getClient(this); */`,
  })).playServicesScannerPath, false);
});

for (const [label, declaration] of [
  [
    "Code Scanner map notation",
    "implementation group: 'com.google.android.gms', name: 'play-services-code-scanner', version: '16.1.0'",
  ],
  [
    "unbundled ML Kit map notation",
    'implementation(group: "com.google.android.gms", name: "play-services-mlkit-barcode-scanning", version: "18.3.1")',
  ],
]) {
  test(`rejects direct ${label}`, () => {
    assert.throws(() => parseQrScannerEvidence(evidence({
      appGradle: `${goodGradle}\n${declaration}`,
      dependencies: goodDependencies,
    })), /QR scanner inspection failed/);
  });
}

test("rejects a version-catalog scanner dependency corroborated by a root graph edge", () => {
  assert.throws(() => parseQrScannerEvidence(evidence({
    appGradle: `${goodGradle}\nimplementation(libs.playServicesCodeScanner)`,
    dependencies: `${goodDependencies}\n\\--- com.google.android.gms:play-services-code-scanner:16.1.0`,
  })), /QR scanner inspection failed/);
});

for (const [label, update] of [
  ["wrong CameraX coordinate", { appGradle: goodGradle.replace("camera-core:1.5.2", "camera-core:1.5.1") }],
  ["wrong bundled scanner coordinate", { appGradle: goodGradle.replace("barcode-scanning:17.3.0", "barcode-scanning:17.2.0") }],
  ["direct Code Scanner dependency", { appGradle: `${goodGradle}\nimplementation 'com.google.android.gms:play-services-code-scanner:16.1.0'` }],
  ["direct unbundled ML Kit dependency", { appGradle: `${goodGradle}\nimplementation 'com.google.android.gms:play-services-mlkit-barcode-scanning:18.3.1'` }],
  ["GMS call site", { activitySource: `${goodSource}\nGmsBarcodeScanning.getClient(this);` }],
  ["missing bundled getClient call", { activitySource: "BarcodeScanner scanner;" }],
  ["dynamic barcode model metadata", { manifest: '<meta-data android:name="com.google.mlkit.vision.DEPENDENCIES" android:value="barcode" />' }],
  ["reversed dynamic barcode metadata", { manifest: '<meta-data android:value="barcode" android:name="com.google.mlkit.vision.DEPENDENCIES" />' }],
  ["multivalue dynamic barcode metadata", { manifest: '<meta-data android:value="ocr, barcode, face" android:name="com.google.mlkit.vision.DEPENDENCIES" />' }],
  ["Code Scanner Dex class", { dexListing: "C com.google.mlkit.vision.codescanner.GmsBarcodeScanning" }],
  ["missing bundled scanner class", { dexListing: "C com.google.android.gms.common.util.Clock" }],
  ["missing model", { apkFiles: goodFiles.replace("oned_feature_extractor_mobile.tflite", "other.bin") }],
  ["missing native decoder", { apkFiles: goodFiles.replace("libbarhopper_v3.so", "libother.so") }],
]) {
  test(`fails closed for ${label}`, () => {
    assert.throws(() => parseQrScannerEvidence(evidence(update)), /QR scanner inspection failed/);
  });
}

test("allows unrelated Google utility classes", () => {
  assert.equal(parseQrScannerEvidence(evidence({
    dexListing: "C com.google.android.gms.common.util.Clock\nC com.google.mlkit.vision.barcode.BarcodeScanner",
  })).playServicesScannerPath, false);
});

test("runs Gradle and each APK analyzer inspection with injected runners", async () => {
  const calls = [];
  const outputs = [goodDependencies, "<manifest><application /></manifest>", goodFiles, "C com.google.mlkit.vision.barcode.BarcodeScanner"];
  const result = await inspectQrScanner({
    apkPath: "/tmp/app.apk",
    mobileRoot: "/workspace/apps/mobile",
    sdkRoot: "/sdk",
    readText: async (path) => path.endsWith("build.gradle") ? goodGradle : goodSource,
    runCommand: async (command, args) => {
      calls.push([command, args]);
      return { status: 0, stdout: outputs.shift(), stderr: "", truncated: false };
    },
  });

  assert.equal(result.bundledDecoder, true);
  assert.deepEqual(calls.map(([, args]) => args), [
    ["--no-daemon", ":app:dependencies", "--configuration", "debugRuntimeClasspath"],
    ["manifest", "print", "/tmp/app.apk"],
    ["files", "list", "/tmp/app.apk"],
    ["dex", "packages", "--defined-only", "/tmp/app.apk"],
  ]);
});

for (const mutation of [
  (result) => ({ ...result, status: 1 }),
  (result) => ({ ...result, stdout: "" }),
  (result) => ({ ...result, truncated: true }),
]) {
  test("fails closed on unusable command output", async () => {
    await assert.rejects(() => inspectQrScanner({
      apkPath: "/tmp/app.apk",
      mobileRoot: "/workspace/apps/mobile",
      sdkRoot: "/sdk",
      readText: async (path) => path.endsWith("build.gradle") ? goodGradle : goodSource,
      runCommand: async () => mutation({ status: 0, stdout: goodDependencies, stderr: "", truncated: false }),
    }), /QR scanner inspection failed/);
  });
}

test("normalizes a missing command into a fail-closed inspection error", async () => {
  await assert.rejects(() => inspectQrScanner({
    apkPath: "/tmp/app.apk",
    mobileRoot: "/workspace/apps/mobile",
    sdkRoot: "/sdk",
    readText: async (path) => path.endsWith("build.gradle") ? goodGradle : goodSource,
    runCommand: async () => { throw new Error("/private/tool/path missing"); },
  }), /^Error: QR scanner inspection failed$/);
});

test("bounds an injected command runner that never settles", async () => {
  const started = Date.now();
  await assert.rejects(() => inspectQrScanner({
    apkPath: "/tmp/app.apk",
    mobileRoot: "/workspace/apps/mobile",
    sdkRoot: "/sdk",
    commandTimeoutMs: 5,
    readText: async (path) => path.endsWith("build.gradle") ? goodGradle : goodSource,
    runCommand: async () => new Promise(() => {}),
  }), /^Error: QR scanner inspection failed$/);
  assert.ok(Date.now() - started < 1_000);
});
