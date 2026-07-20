import { access, copyFile, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const mobileRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = resolve(mobileRoot, "../..");
const androidRoot = resolve(mobileRoot, "android");
const hyperdhtRoot = resolve(repositoryRoot, "third_party/hyperdht-cpp");
const cacheRoot = resolve(androidRoot, ".hyperdht");
const depsRoot = resolve(cacheRoot, "deps");
const output = resolve(androidRoot, "app/src/main/jniLibs/arm64-v8a/libhyperdht_jni.so");
const ABI = "arm64-v8a";
const API = "26";
const HYPERDHT_COMMIT = "91ab6a2dcf9394bef8b788f9199422f5f56243cf";
const LIBSODIUM_COMMIT = "2ce4d906a68eae82b27b4867f3d4172ec508cb27";
const LIBUV_COMMIT = "5152db2cbfeb5582e9c27c5ea1dba2cd9e10759b";

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: options.cwd, env: options.env, stdio: "inherit" });
  if (result.status !== 0) throw new Error(`${command} ${args[0] ?? ""} failed`);
}

async function exists(path) {
  try { await access(path); return true; } catch { return false; }
}

async function usableStaticArchive(path) {
  try { return (await stat(path)).size > 64 * 1024; } catch { return false; }
}

function gitHead(path) {
  const result = spawnSync("git", ["-C", path, "rev-parse", "HEAD"], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`cannot read source revision at ${path}`);
  return result.stdout.trim();
}

async function ensureCheckout(path, url, branch, commit) {
  if (!(await exists(resolve(path, ".git")))) {
    await mkdir(dirname(path), { recursive: true });
    run("git", ["clone", "--depth", "1", "--branch", branch, url, path]);
  }
  if (gitHead(path) !== commit) throw new Error(`pinned source revision changed for ${path}; refresh this script intentionally`);
}

async function patchedJniSource() {
  const source = resolve(hyperdhtRoot, "wrappers/kotlin/src/main/cpp/hyperdht_jni.cpp");
  const destination = resolve(cacheRoot, "hyperdht_jni.cpp");
  const contents = await readFile(source, "utf8");
  const legacy = "g_jvm->AttachCurrentThread((void**)&env, nullptr);";
  if (!contents.includes(legacy)) throw new Error("review the HyperDHT JNI attach patch for the pinned source revision");
  // NDK r28's C++ header requires JNIEnv**, while older headers accepted void**.
  await writeFile(destination, contents.replace(legacy, "g_jvm->AttachCurrentThread(&env, nullptr);"), "utf8");
  return destination;
}

function ndkRoot() {
  const explicit = process.env.ANDROID_NDK_HOME ?? process.env.ANDROID_NDK_ROOT;
  if (explicit !== undefined) return explicit;
  throw new Error("ANDROID_NDK_HOME must name Android NDK r28 or newer");
}

function ndkHostTag() {
  if (process.platform === "darwin") return "darwin-x86_64";
  if (process.platform === "linux") return "linux-x86_64";
  throw new Error("HyperDHT Android source build is supported on macOS and Linux only");
}

async function main() {
  if (gitHead(hyperdhtRoot) !== HYPERDHT_COMMIT) throw new Error("HyperDHT submodule is not at the reviewed pinned revision");
  if (!(await exists(resolve(hyperdhtRoot, "deps/libudx/CMakeLists.txt")))) {
    throw new Error("initialize HyperDHT submodules before building Android native code");
  }
  const ndk = ndkRoot();
  const host = ndkHostTag();
  const toolchain = resolve(ndk, `toolchains/llvm/prebuilt/${host}`);
  if (!(await exists(resolve(toolchain, "bin/aarch64-linux-android26-clang++")))) {
    throw new Error(`Android arm64 compiler is unavailable in ${toolchain}`);
  }

  const sodiumRoot = resolve(depsRoot, "libsodium");
  const uvRoot = resolve(depsRoot, "libuv");
  await ensureCheckout(sodiumRoot, "https://github.com/jedisct1/libsodium.git", "stable", LIBSODIUM_COMMIT);
  await ensureCheckout(uvRoot, "https://github.com/libuv/libuv.git", "v1.51.0", LIBUV_COMMIT);

  const sodiumPrefix = resolve(sodiumRoot, "libsodium-android-armv8-a+crypto");
  const sodiumLibrary = resolve(sodiumPrefix, "lib/libsodium.a");
  const sodiumMarker = resolve(sodiumPrefix, ".t4-full-static-build");
  if (!(await usableStaticArchive(sodiumLibrary)) || !(await exists(sodiumMarker))) {
    // libsodium's Android helper produces an empty static archive and a shared
    // library with unresolved ARM-crypto symbols on this pinned release.
    // Build the complete static library ourselves so every symbol is bundled
    // into the JNI library and Android has no secondary native dependency.
    await rm(sodiumPrefix, { force: true, recursive: true });
    if (await exists(resolve(sodiumRoot, "Makefile"))) run("make", ["distclean"], { cwd: sodiumRoot });
    run("./autogen.sh", [], {
      cwd: sodiumRoot,
      env: { ...process.env, LIBTOOLIZE: process.platform === "darwin" ? "glibtoolize" : "libtoolize" },
    });
    run("./configure", ["--host=aarch64-linux-android", `--prefix=${sodiumPrefix}`, `--with-sysroot=${resolve(toolchain, "sysroot")}`, "--disable-shared", "--enable-static", "--disable-pie"], {
      cwd: sodiumRoot,
      env: {
        ...process.env,
        PATH: `${resolve(toolchain, "bin")}:${process.env.PATH ?? ""}`,
        CC: resolve(toolchain, "bin/aarch64-linux-android26-clang"),
        AR: resolve(toolchain, "bin/llvm-ar"),
        RANLIB: resolve(toolchain, "bin/llvm-ranlib"),
        STRIP: resolve(toolchain, "bin/llvm-strip"),
        CFLAGS: "-Os -march=armv8-a+crypto",
        LDFLAGS: "-Wl,-z,max-page-size=16384",
      },
    });
    run("make", ["-j4", "install"], { cwd: sodiumRoot });
    await writeFile(sodiumMarker, `${LIBSODIUM_COMMIT}\n`, "utf8");
  }

  const uvBuild = resolve(cacheRoot, "libuv-build");
  const uvInstall = resolve(cacheRoot, "libuv-install");
  const uvLibrary = resolve(uvInstall, "lib/libuv.a");
  if (!(await exists(uvLibrary))) {
    await rm(uvBuild, { force: true, recursive: true });
    run("cmake", ["-B", uvBuild, "-S", uvRoot, "-G", "Ninja", `-DCMAKE_TOOLCHAIN_FILE=${resolve(ndk, "build/cmake/android.toolchain.cmake")}`, `-DANDROID_ABI=${ABI}`, `-DANDROID_PLATFORM=android-${API}`, "-DCMAKE_BUILD_TYPE=Release", "-DLIBUV_BUILD_TESTS=OFF", `-DCMAKE_INSTALL_PREFIX=${uvInstall}`]);
    run("ninja", ["-C", uvBuild, "install"]);
  }

  const hyperdhtBuild = resolve(cacheRoot, `hyperdht-build-${HYPERDHT_COMMIT}`);
  const builtLibrary = resolve(hyperdhtBuild, "libhyperdht.a");
  if (!(await exists(builtLibrary))) {
    await rm(hyperdhtBuild, { force: true, recursive: true });
    run("cmake", ["-B", hyperdhtBuild, "-S", hyperdhtRoot, "-G", "Ninja", `-DCMAKE_TOOLCHAIN_FILE=${resolve(ndk, "build/cmake/android.toolchain.cmake")}`, `-DANDROID_ABI=${ABI}`, `-DANDROID_PLATFORM=android-${API}`, "-DCMAKE_BUILD_TYPE=Release", "-DHYPERDHT_BUILD_TESTS=OFF", "-DCMAKE_DISABLE_FIND_PACKAGE_PkgConfig=ON", `-DSODIUM_INCLUDE_DIR=${resolve(sodiumPrefix, "include")}`, `-DSODIUM_LIBRARY=${sodiumLibrary}`, `-DUV_INCLUDE_DIR=${resolve(uvInstall, "include")}`, `-DUV_LIBRARY=${uvLibrary}`]);
    run("ninja", ["-C", hyperdhtBuild]);
  }

  const shared = resolve(cacheRoot, "libhyperdht_jni.so");
  const jniSource = await patchedJniSource();
  run(resolve(toolchain, "bin/aarch64-linux-android26-clang++"), ["-std=c++20", "-O2", "-shared", "-fPIC", "-static-libstdc++", `-I${resolve(hyperdhtRoot, "include")}`, `-I${resolve(hyperdhtRoot, "deps/libudx/include")}`, `-I${resolve(uvInstall, "include")}`, `-I${resolve(toolchain, "sysroot/usr/include")}`, jniSource, builtLibrary, resolve(hyperdhtBuild, "libudx.a"), sodiumLibrary, uvLibrary, "-llog", "-Wl,-z,max-page-size=16384", "-o", shared]);
  await mkdir(dirname(output), { recursive: true });
  await copyFile(shared, output);
  console.log(`Built ${output}`);
}

await main();
