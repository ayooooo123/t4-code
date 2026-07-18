import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

const mobileRoot = resolve(import.meta.dirname, "..");

test("Capacitor uses bundled assets and a local secure origin", async () => {
  const config = JSON.parse(await readFile(resolve(mobileRoot, "capacitor.config.json"), "utf8"));

  assert.equal(config.webDir, "dist");
  assert.equal(config.server.hostname, "localhost");
  assert.equal(config.server.androidScheme, "https");
  assert.equal(config.server.url, undefined);
  assert.equal(config.server.allowNavigation, undefined);
  assert.equal(config.server.cleartext, undefined);
});

test("Android sync rebuilds the web app before copying bundled assets", async () => {
  const packageJson = JSON.parse(await readFile(resolve(mobileRoot, "package.json"), "utf8"));

  assert.match(
    packageJson.scripts["prepare:web"],
    /^pnpm --filter @t4-code\/web build && node \.\/scripts\/prepare-web\.mjs$/,
  );
  assert.match(packageJson.scripts["sync:android"], /^pnpm prepare:web && cap sync android$/);
});

test("mobile package pins one Capacitor release across core, CLI, and Android", async () => {
  const packageJson = JSON.parse(await readFile(resolve(mobileRoot, "package.json"), "utf8"));
  const core = packageJson.dependencies["@capacitor/core"];

  assert.equal(core, "8.4.1");
  assert.equal(packageJson.devDependencies["@capacitor/cli"], core);
  assert.equal(packageJson.devDependencies["@capacitor/android"], core);
});

test("Android credentials are encrypted by a registered Keystore plugin", async () => {
  const sourceRoot = resolve(
    mobileRoot,
    "android/app/src/main/java/com/lycaonsolutions/t4code",
  );
  const activity = await readFile(resolve(sourceRoot, "MainActivity.java"), "utf8");
  const plugin = await readFile(resolve(sourceRoot, "T4SecureStoragePlugin.java"), "utf8");

  assert.match(activity, /registerPlugin\(T4SecureStoragePlugin\.class\)/);
  assert.match(plugin, /@CapacitorPlugin\(name = "T4SecureStorage"\)/);
  assert.match(plugin, /AES\/GCM\/NoPadding/);
  assert.match(plugin, /AndroidKeyStore/);
  assert.match(plugin, /setCredentials\(PluginCall call\)/);
  assert.match(plugin, /getCredentials\(PluginCall call\)/);
  assert.match(plugin, /clearCredentials\(PluginCall call\)/);
  assert.doesNotMatch(plugin, /putString\([^,]+,\s*deviceToken\)/);
});

test("Android secure credentials are host-scoped and migrate legacy storage", async () => {
  const sourceRoot = resolve(
    mobileRoot,
    "android/app/src/main/java/com/lycaonsolutions/t4code",
  );
  const plugin = await readFile(resolve(sourceRoot, "T4SecureStoragePlugin.java"), "utf8");

  assert.match(plugin, /call\.getString\("hostKey"\)/);
  assert.match(plugin, /MAX_HOST_KEY_LENGTH/);
  assert.equal((plugin.match(/String hostKey = call\.getString\("hostKey"\)/g) ?? []).length, 3);
  assert.equal((plugin.match(/isBoundedText\(hostKey, MAX_HOST_KEY_LENGTH\)/g) ?? []).length, 3);
  assert.match(plugin, /call\.getBoolean\("migrateLegacy", false\)/);
  assert.match(plugin, /readCredentials\(hostKey, migrateLegacy\)/);
  assert.match(plugin, /if \(!migrateLegacy\) return null/);
  assert.match(plugin, /MessageDigest\.getInstance\("SHA-256"\)/);
  assert.match(plugin, /PREFERENCE_IV_PREFIX/);
  assert.match(plugin, /PREFERENCE_PAYLOAD_PREFIX/);
  assert.match(plugin, /preferenceIv\(hostKey\)/);
  assert.match(plugin, /preferencePayload\(hostKey\)/);
  assert.match(plugin, /cipher\.updateAAD\(hostKey\.getBytes\(StandardCharsets\.UTF_8\)\)/);
  assert.match(plugin, /putString\(preferenceIv\(hostKey\), Base64\.encodeToString/);
  assert.match(plugin, /putString\(preferencePayload\(hostKey\), Base64\.encodeToString/);
  assert.match(plugin, /decryptCredentials\(legacyIv, legacyPayload, null\)/);
  assert.match(plugin, /storeCredentials\(hostKey, credentials\.toString\(\), true\)/);
  assert.match(plugin, /SharedPreferences\.Editor editor = preferences\(\)\.edit\(\)/);
  assert.match(plugin, /if \(removeLegacy\)/);
  assert.match(plugin, /PREFERENCE_IV = "credentials_iv"/);
  assert.match(plugin, /PREFERENCE_PAYLOAD = "credentials_payload"/);
  assert.match(plugin, /remove\(PREFERENCE_IV\)/);
  assert.doesNotMatch(plugin, /storedPreferences\.edit\(\)\s*\.remove\(PREFERENCE_IV\)/);
  assert.match(plugin, /remove\(PREFERENCE_PAYLOAD\)/);
  assert.match(plugin, /clearStoredState\(hostKey\)/);
  assert.doesNotMatch(plugin, /preferences\(\)\.edit\(\)\.clear\(\)/);
  assert.doesNotMatch(plugin, /keyStore\.deleteEntry\(KEY_ALIAS\)/);
  assert.doesNotMatch(plugin, /putString\([^)]*deviceToken/);
  assert.doesNotMatch(plugin, /putString\([^)]*"deviceToken"/);
});

test("Android foreground resume wakes the browser connection immediately", async () => {
  const activity = await readFile(
    resolve(
      mobileRoot,
      "android/app/src/main/java/com/lycaonsolutions/t4code/MainActivity.java",
    ),
    "utf8",
  );

  assert.match(activity, /void onResume\(\)/);
  assert.match(activity, /super\.onResume\(\)/);
  assert.match(activity, /void onPause\(\)/);
  assert.match(activity, /hasEnteredBackground = true/);
  assert.match(activity, /if \(hasEnteredBackground && getBridge\(\) != null\)/);
  assert.match(activity, /triggerWindowJSEvent\(APP_RESUME_EVENT\)/);
  assert.match(activity, /APP_RESUME_EVENT = "t4:native-resume"/);
});

test("Android updates use a registered native bridge with no renderer-supplied URL", async () => {
  const sourceRoot = resolve(
    mobileRoot,
    "android/app/src/main/java/com/lycaonsolutions/t4code",
  );
  const activity = await readFile(resolve(sourceRoot, "MainActivity.java"), "utf8");
  const fileProvider = await readFile(resolve(sourceRoot, "T4FileProvider.java"), "utf8");
  const fileStore = await readFile(resolve(sourceRoot, "T4UpdateFileStore.java"), "utf8");
  const plugin = await readFile(resolve(sourceRoot, "T4UpdatePlugin.java"), "utf8");
  const verifier = await readFile(resolve(sourceRoot, "T4UpdateVerifier.java"), "utf8");
  const manifest = await readFile(resolve(mobileRoot, "android/app/src/main/AndroidManifest.xml"), "utf8");
  const providerPaths = await readFile(
    resolve(mobileRoot, "android/app/src/main/res/xml/file_paths.xml"),
    "utf8",
  );

  assert.match(activity, /registerPlugin\(T4UpdatePlugin\.class\)/);
  assert.match(plugin, /@CapacitorPlugin\(name = "T4Update"\)/);
  assert.match(plugin, /https:\/\/t4code\.net\/releases\/latest\.json/);
  assert.match(verifier, /https:\/\/github\.com\/LycaonLLC\/t4-code\/releases\/download\//);
  assert.match(plugin, /checkForUpdate\(PluginCall call\)/);
  assert.match(plugin, /openUpdate\(PluginCall call\)/);
  assert.match(plugin, /T4UpdateVerifier\.copyExact\(input, output, release\.apkSize, release\.apkSha256\)/);
  assert.match(plugin, /EXPECTED_PACKAGE_ID = "com\.lycaonsolutions\.t4code"/);
  assert.match(plugin, /expectedVersion\.equals\(candidate\.versionName\)/);
  assert.match(plugin, /PackageManager\.GET_SIGNING_CERTIFICATES/);
  assert.match(plugin, /PackageManager\.GET_SIGNATURES/);
  assert.match(plugin, /getSigningCertificateHistory\(\)/);
  assert.match(plugin, /T4UpdateVerifier\.isTrustedSignerTransition\(/);
  assert.match(plugin, /T4UpdateVerifier\.sameSignerSet\(legacySigners\(installed\), legacySigners\(candidate\)\)/);
  assert.match(fileStore, /File\.createTempFile\("T4-Code-" \+ version/);
  assert.match(fileStore, /verified\.setReadOnly\(\)/);
  assert.match(fileStore, /ACTIVE_OWNERS\.put\(ownershipKey, ownerToken\)/);
  assert.match(fileStore, /requireOwnership\(\)/);
  assert.match(plugin, /updateState\.installerOpened\(\)/);
  assert.match(plugin, /notifyListeners\(STATE_CHANGED_EVENT, state\)/);
  assert.match(plugin, /result\.put\("revision", updateState\.revision\(\)\)/);
  assert.match(plugin, /BuildConfig\.APPLICATION_ID/);
  assert.match(plugin, /BuildConfig\.VERSION_NAME/);
  assert.match(plugin, /FileProvider\.getUriForFile/);
  assert.match(plugin, /new Intent\(Intent\.ACTION_VIEW\)/);
  assert.match(plugin, /Intent\.FLAG_GRANT_READ_URI_PERMISSION/);
  assert.match(verifier, /count > expectedSize - total/);
  assert.match(verifier, /total != expectedSize/);
  assert.match(verifier, /MessageDigest\.getInstance\("SHA-256"\)/);
  assert.match(manifest, /android\.permission\.REQUEST_INSTALL_PACKAGES/);
  assert.match(fileProvider, /final class T4FileProvider extends FileProvider/);
  assert.match(manifest, /android:name="\.T4FileProvider"/);
  assert.match(providerPaths, /<cache-path name="verified_updates" path="t4-updates\/" \/>/);
  assert.doesNotMatch(providerPaths, /<external-path/);
  assert.doesNotMatch(providerPaths, /path="\."/);
  assert.doesNotMatch(plugin, /call\.getString\("(?:url|uri|path)"\)/);
  assert.doesNotMatch(plugin, /setInstanceFollowRedirects\(true\)/);
  assert.doesNotMatch(plugin, /CATEGORY_BROWSABLE/);
  assert.doesNotMatch(plugin, /android\.content\.pm\.PackageInstaller|PackageInstaller\.Session/);
  assert.doesNotMatch(plugin, /validatedApkUrl/);
  assert.doesNotMatch(plugin, /return "0\.0\.0"/);
});

test("the bundled document restricts connections without constraining the hosted web build", async () => {
  const prepareScript = await readFile(resolve(mobileRoot, "scripts/prepare-web.mjs"), "utf8");
  const hostedIndex = await readFile(resolve(mobileRoot, "../web/index.html"), "utf8");

  assert.match(prepareScript, /connect-src 'self' wss:\/\/\*\.ts\.net:\*/);
  assert.match(prepareScript, /img-src 'self' data: blob:/);
  assert.match(prepareScript, /http-equiv="Content-Security-Policy"/);
  assert.doesNotMatch(prepareScript, /connect-src \*/);
  assert.doesNotMatch(hostedIndex, /http-equiv="Content-Security-Policy"/);
});

test("the Android build verifies its Gradle distribution", async () => {
  const wrapper = await readFile(
    resolve(mobileRoot, "android/gradle/wrapper/gradle-wrapper.properties"),
    "utf8",
  );

  assert.match(wrapper, /^distributionSha256Sum=[a-f0-9]{64}$/mu);
  assert.match(wrapper, /^validateDistributionUrl=true$/mu);
});

test("the HyperDHT JNI build links a complete static libsodium", async () => {
  const script = await readFile(resolve(mobileRoot, "scripts/build-hyperdht-android.mjs"), "utf8");

  assert.match(script, /const sodiumLibrary = resolve\(sodiumPrefix, "lib\/libsodium\.a"\)/);
  assert.match(script, /"--disable-shared", "--enable-static"/);
  assert.doesNotMatch(script, /"--enable-minimal"/);
  assert.doesNotMatch(script, /copyFile\(sodiumLibrary, sodiumOutput\)/);
});

test("private Android connections have a bounded native open attempt", async () => {
  const plugin = await readFile(resolve(mobileRoot, "android/app/src/main/kotlin/com/lycaonsolutions/t4code/T4PeerConnectionPlugin.kt"), "utf8");

  assert.match(plugin, /const val NATIVE_OPEN_TIMEOUT_MS = [\d_]+L/);
  assert.match(plugin, /withTimeout\(NATIVE_OPEN_TIMEOUT_MS\)/);
  assert.match(plugin, /call\.reject\(message\)/);
  assert.doesNotMatch(plugin, /call\.reject\(message\)\s+try \{ dht\?\.close\(\) \}/);
});

test("private Android reconnects retain the app-process DHT node", async () => {
  const plugin = await readFile(resolve(mobileRoot, "android/app/src/main/kotlin/com/lycaonsolutions/t4code/T4PeerConnectionPlugin.kt"), "utf8");

  assert.match(plugin, /private var activeDht: HyperDHT\? = null/);
  assert.match(plugin, /private fun dht\(\): HyperDHT/);
  assert.doesNotMatch(plugin, /Session\(\s*val dht: HyperDHT/);
  assert.doesNotMatch(plugin, /session\.dht\.close\(\)/);
});

test("private Android DHT follows activity pause and resume", async () => {
  const plugin = await readFile(resolve(mobileRoot, "android/app/src/main/kotlin/com/lycaonsolutions/t4code/T4PeerConnectionPlugin.kt"), "utf8");

  assert.match(plugin, /override fun handleOnPause\(\)/);
  assert.match(plugin, /activeDht\?\.suspend\(\)/);
  assert.match(plugin, /override fun handleOnResume\(\)/);
  assert.match(plugin, /activeDht\?\.resume\(\)/);
});

test("private Android reconnects recreate stale DHT state after a long background interval", async () => {
  const plugin = await readFile(resolve(mobileRoot, "android/app/src/main/kotlin/com/lycaonsolutions/t4code/T4PeerConnectionPlugin.kt"), "utf8");

  assert.match(plugin, /SystemClock\.elapsedRealtime\(\)/);
  assert.match(plugin, /LONG_BACKGROUND_RESET_MS/);
  assert.match(plugin, /resetDhtBeforeNextOpen = true/);
  assert.match(plugin, /activeDht = null/);
  assert.match(plugin, /retiredDht\?\.close\(\)/);
});

test("Android QR scanning is app-owned, offline, and pinned", async () => {
  const packageJson = JSON.parse(await readFile(resolve(mobileRoot, "package.json"), "utf8"));
  const appGradle = await readFile(resolve(mobileRoot, "android/app/build.gradle"), "utf8");
  const manifest = await readFile(
    resolve(mobileRoot, "android/app/src/main/AndroidManifest.xml"),
    "utf8",
  );

  assert.equal(packageJson.dependencies["@capacitor-mlkit/barcode-scanning"], undefined);
  assert.match(manifest, /<uses-permission android:name="android\.permission\.CAMERA" \/>/);
  assert.match(
    manifest,
    /<uses-feature\s+android:name="android\.hardware\.camera"\s+android:required="false"\s+\/>/,
  );
  assert.match(
    manifest,
    /<activity\s+android:name="\.T4QrScannerActivity"\s+android:exported="false"/,
  );

  for (const artifact of ["camera-camera2", "camera-core", "camera-lifecycle", "camera-view"]) {
    assert.match(appGradle, new RegExp(`androidx\\.camera:${artifact}:1\\.5\\.2`));
  }
  assert.match(appGradle, /com\.google\.mlkit:barcode-scanning:17\.3\.0/);

  const forbiddenSources = [JSON.stringify(packageJson), appGradle, manifest].join("\n");
  assert.doesNotMatch(forbiddenSources, /@capacitor-mlkit\/barcode-scanning/);
  assert.doesNotMatch(forbiddenSources, /play-services-code-scanner/);
  assert.doesNotMatch(forbiddenSources, /play-services-mlkit-barcode-scanning/);
  assert.doesNotMatch(forbiddenSources, /com\.google\.mlkit\.vision\.DEPENDENCIES[^\n]*barcode_ui/);
});

test("mobile QR acceptance and privacy inspectors stay pinned and scriptable", async () => {
  const packageJson = JSON.parse(await readFile(resolve(mobileRoot, "package.json"), "utf8"));

  assert.equal(packageJson.devDependencies.qrcode, "1.5.4");
  assert.equal(packageJson.scripts["inspect:qr"], "node ./scripts/inspect-qr-scanner.mjs");
  assert.equal(packageJson.scripts["fixtures:qr"], "node ./scripts/generate-qr-acceptance-fixtures.mjs");
  assert.equal(packageJson.scripts["inspect:storage"], "node ./scripts/inspect-mobile-storage.mjs");
});

test("Android QR scanner startup failures settle after entering the capture lifecycle", async () => {
  const activity = await readFile(
    resolve(
      mobileRoot,
      "android/app/src/main/java/com/lycaonsolutions/t4code/T4QrScannerActivity.java",
    ),
    "utf8",
  );

  const startedAt = activity.indexOf("captureState.started()");
  const permissionAt = activity.indexOf("ActivityCompat.checkSelfPermission");
  const executorAt = activity.indexOf("Executors.newSingleThreadExecutor()");
  const decoderAt = activity.indexOf("BarcodeScanning.getClient(options)");
  const providerAt = activity.indexOf("ProcessCameraProvider.getInstance(this)");

  assert.ok(startedAt >= 0 && startedAt < permissionAt);
  assert.ok(permissionAt < executorAt && executorAt < decoderAt && decoderAt < providerAt);
  assert.match(activity, /catch \(RuntimeException \| LinkageError error\) \{\s*finishFailed\("scanner_executor"\)/);
  assert.match(activity, /catch \(RuntimeException \| LinkageError error\) \{\s*finishFailed\("scanner_decoder"\)/);
  assert.match(activity, /catch \(RuntimeException \| LinkageError error\) \{\s*finishFailed\("camera_provider"\)/);
  assert.match(activity, /private void finishTerminal[\s\S]*finishStarted\.compareAndSet\(false, true\)/);
  assert.match(activity, /private void finishTerminal[\s\S]*cleanupScanner\(false\);\s*finish\(\);/);
});

test("Android QR scanner controls honor system bars and display cutouts", async () => {
  const activity = await readFile(
    resolve(
      mobileRoot,
      "android/app/src/main/java/com/lycaonsolutions/t4code/T4QrScannerActivity.java",
    ),
    "utf8",
  );
  const layout = await readFile(
    resolve(mobileRoot, "android/app/src/main/res/layout/activity_t4_qr_scanner.xml"),
    "utf8",
  );

  assert.match(layout, /android:id="@\+id\/t4_qr_root"/);
  assert.match(activity, /WindowCompat\.setDecorFitsSystemWindows\(getWindow\(\), false\)/);
  assert.match(activity, /ViewCompat\.setOnApplyWindowInsetsListener/);
  assert.match(activity, /WindowInsetsCompat\.Type\.systemBars\(\)/);
  assert.match(activity, /WindowInsetsCompat\.Type\.displayCutout\(\)/);
  assert.match(activity, /statusLayout\.topMargin = statusBaseTopMargin \+ safeInsets\.top/);
  assert.match(activity, /cancelLayout\.bottomMargin = cancelBaseBottomMargin \+ safeInsets\.bottom/);
});

test("Android QR frame and terminal ownership are explicit and exception-safe", async () => {
  const activity = await readFile(
    resolve(
      mobileRoot,
      "android/app/src/main/java/com/lycaonsolutions/t4code/T4QrScannerActivity.java",
    ),
    "utf8",
  );

  assert.match(activity, /new T4QrTerminalCoordinator\(this::runOnUiThread\)/);
  assert.match(activity, /import androidx\.camera\.core\.ExperimentalGetImage;/);
  assert.match(activity, /import androidx\.annotation\.OptIn;/);
  assert.match(
    activity,
    /@OptIn\(markerClass = ExperimentalGetImage\.class\)\s+public final class T4QrScannerActivity/,
  );
  assert.match(activity, /new T4QrFrameSettlement\(/);
  assert.match(activity, /addOnFailureListener\(error -> frame\.failed\(\)\)/);
  assert.match(activity, /addOnCompleteListener\(completedTask -> frame\.completed\(\)\)/);
  assert.match(activity, /catch \(RuntimeException \| LinkageError error\) \{\s*frame\.failed\(\)/);
  assert.match(activity, /if \(!cleanup\.isStarted\(\)\) finishFailedNow\("scanner_error"\)/);
  assert.match(activity, /new T4QrCleanup\(\)/);
  assert.match(activity, /cleanup\.run\(/);
  assert.doesNotMatch(activity, /catch \([^)]* error\) \{[^}]*error\.(?:getMessage|toString)/);
});

test("Android QR terminal rejection resolves atomically with active-claim removal", async () => {
  const coordinator = await readFile(
    resolve(
      mobileRoot,
      "android/app/src/main/java/com/lycaonsolutions/t4code/T4QrTerminalCoordinator.java",
    ),
    "utf8",
  );

  assert.match(
    coordinator,
    /private boolean rejectScheduling\(Claim claim\) \{\s*synchronized \(schedulingMonitor\) \{[\s\S]*claim\.cancelBeforeRun\(\)[\s\S]*claim\.resolveScheduling\(\)[\s\S]*active = null[\s\S]*schedulingMonitor\.notifyAll\(\)/,
  );
  assert.match(
    coordinator,
    /catch \(RuntimeException \| LinkageError ignored\) \{\s*boolean accepted = rejectScheduling\(claim\)/,
  );
  assert.doesNotMatch(
    coordinator,
    /catch \(RuntimeException \| LinkageError ignored\) \{\s*boolean cancelled = claim\.cancelBeforeRun\(\)/,
  );
});

test("Android exposes a registered cancellable native QR scanner contract", async () => {
  const sourceRoot = resolve(
    mobileRoot,
    "android/app/src/main/java/com/lycaonsolutions/t4code",
  );
  const activity = await readFile(resolve(sourceRoot, "MainActivity.java"), "utf8");
  const plugin = await readFile(resolve(sourceRoot, "T4QrScannerPlugin.java"), "utf8");
  const scanner = await readFile(resolve(sourceRoot, "T4QrScannerActivity.java"), "utf8");

  assert.match(activity, /registerPlugin\(T4QrScannerPlugin\.class\)/);
  assert.match(plugin, /@CapacitorPlugin\(name = "T4QrScanner"/);
  assert.match(plugin, /@PluginMethod\s+public void isSupported\(PluginCall call\)/);
  assert.match(plugin, /@PluginMethod\s+public void cameraPermission\(PluginCall call\)/);
  assert.match(plugin, /@PluginMethod\s+public void requestCameraPermission\(PluginCall call\)/);
  assert.match(plugin, /@PluginMethod\s+public void startScan\(PluginCall call\)/);
  assert.match(plugin, /@PluginMethod\s+public void cancelScan\(PluginCall call\)/);
  assert.match(plugin, /startActivityForResult\(call, intent, "scanFinished"\)/);
  assert.match(plugin, /@ActivityCallback\s+private void scanFinished\(PluginCall call, ActivityResult result\)/);
  assert.match(plugin, /notifyListeners\("scanResult"/);
  assert.match(plugin, /notifyListeners\("scanClosed"/);
  assert.match(plugin, /notifyListeners\("scanError"/);
  assert.match(plugin, /ACTION_CANCEL_SCAN/);
  assert.ok(plugin.indexOf(".record(attemptId)") < plugin.indexOf("sendBroadcast(cancellation)"));
  assert.match(plugin, /catch \(RuntimeException \| LinkageError error\) \{\s*T4QrCancellationRegistry\.shared\(\)\.remove\(attemptId\);\s*call\.reject\("Unable to cancel QR scan", "cancellation_failed"\)/);
  assert.match(plugin, /catch \(RuntimeException \| LinkageError error\) \{\s*action = session\.error\(expectedAttemptId, "invalid_result"\)/);
  assert.match(scanner, /T4QrCancellationRegistry\.shared\(\)\.consume/);
  assert.match(scanner, /ContextCompat\.RECEIVER_NOT_EXPORTED/);
  assert.match(scanner, /catch \(RuntimeException \| LinkageError error\) \{\s*finishFailed\("cancellation_receiver"\)/);
  assert.match(scanner, /cleanup\.run\(\s*\(\) -> \{\s*if \(unregisterCancellationReceiver/);
  assert.match(scanner, /protected void onDestroy\(\) \{\s*cleanupScanner\(isChangingConfigurations\(\)\)/);
  assert.match(scanner, /T4QrCancellationRegistry\.shared\(\)\.cleanup\(\s*captureState\.attemptId\(\),\s*changingConfigurations\s*\)/);
  assert.doesNotMatch(plugin, /static\s+(?:PluginCall|T4QrScannerActivity)/);
});
