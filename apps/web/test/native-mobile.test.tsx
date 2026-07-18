import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { MobileConnectionScreen } from "../src/components/MobileConnectionScreen.tsx";
import {
  MOBILE_BACKEND_STORAGE_KEY,
  MOBILE_HOST_DIRECTORY_STORAGE_KEY,
  nativeQrScanner,
  persistNativeMobileCredentials,
  prepareNativeMobileBackend,
  probeMobileBackend,
  readStoredMobileBackend,
  readStoredMobileConnection,
  readStoredMobileBackendDirectory,
  replaceStoredMobileBackend,
  removeNativeMobileBackend,
  selectStoredMobileBackend,
  type StoredMobileBackendDirectory,
  writeStoredMobileBackend,
  writeStoredPeerBackend,
  writeFirstRunPeerBackend,
  writeFirstRunTailnetBackend,
} from "../src/platform/native-mobile.ts";
import {
  parsePeerBackend,
  parseTailnetBackend,
} from "../src/platform/mobile-connection-records.ts";
import { MOBILE_HOST_DIRECTORY_STORAGE_KEY as SCHEMA_MOBILE_HOST_DIRECTORY_STORAGE_KEY } from "../src/platform/mobile-host-schema.ts";

const originalDocument = globalThis.document;
const originalWindow = globalThis.window;

class MemoryStorage {
  readonly values = new Map<string, string>();
  getItem(key: string): string | null { return this.values.get(key) ?? null; }
  setItem(key: string, value: string): void { this.values.set(key, value); }
  removeItem(key: string): void { this.values.delete(key); }
}

class TrackingMemoryStorage extends MemoryStorage {
  readonly operations: string[] = [];
  override getItem(key: string): string | null {
    this.operations.push(`get:${key}`);
    return super.getItem(key);
  }
  override setItem(key: string, value: string): void {
    this.operations.push(`set:${key}`);
    super.setItem(key, value);
  }
  override removeItem(key: string): void {
    this.operations.push(`remove:${key}`);
    super.removeItem(key);
  }
}

function installNativeWindow(storage: MemoryStorage, secure?: object): void {
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: { documentElement: { dataset: {} } },
  });
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      localStorage: storage,
      crypto: globalThis.crypto,
      Capacitor: {
        isNativePlatform: () => true,
        getPlatform: () => "android",
        ...(secure === undefined ? {} : { Plugins: { T4SecureStorage: secure } }),
      },
    },
  });
}

const TEST_KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const TEST_PEER = parsePeerBackend(`t4peer://v1/${TEST_KEY}/${TEST_KEY}`);
const TEST_TAILNET = parseTailnetBackend("https://guard.tailnet.ts.net:8445");
const TEST_TAILNET_DIRECTORY = {
  version: 2,
  activeOrigin: TEST_TAILNET.origin,
  backends: [TEST_TAILNET],
};

afterEach(() => {
  Object.defineProperty(globalThis, "document", { configurable: true, value: originalDocument });
  Object.defineProperty(globalThis, "window", { configurable: true, value: originalWindow });
});

describe("native mobile connection", () => {
  it("re-exports the schema-owned v3 storage key for compatibility", () => {
    expect(MOBILE_HOST_DIRECTORY_STORAGE_KEY).toBe(SCHEMA_MOBILE_HOST_DIRECTORY_STORAGE_KEY);
  });

  it("writes a first-run peer only when every mobile connection key is absent", () => {
    const storage = new MemoryStorage();
    const key = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    const peer = parsePeerBackend(`t4peer://v1/${key}/${key}`);

    expect(writeFirstRunPeerBackend(peer, storage)).toBe(true);
    expect(storage.getItem(MOBILE_BACKEND_STORAGE_KEY)).toBe(JSON.stringify(peer));
    expect(writeFirstRunPeerBackend(peer, storage)).toBe(false);
  });

  it("writes a canonical first-run Tailnet directory once and refuses every occupied key", () => {
    const candidate = parseTailnetBackend("https://first.tailnet.ts.net:8445");
    const clean = new MemoryStorage();
    expect(writeFirstRunTailnetBackend(candidate, clean)).toBe(true);
    expect(JSON.parse(clean.getItem(MOBILE_BACKEND_STORAGE_KEY) ?? "null")).toEqual({
      version: 2,
      activeOrigin: candidate.origin,
      backends: [candidate],
    });
    expect(writeFirstRunTailnetBackend(candidate, clean)).toBe(false);

    for (const occupiedKey of [
      "t4-code:mobile-backend:v1",
      MOBILE_BACKEND_STORAGE_KEY,
      MOBILE_HOST_DIRECTORY_STORAGE_KEY,
    ]) {
      const storage = new MemoryStorage();
      storage.setItem(occupiedKey, "exact opaque bytes");
      expect(writeFirstRunTailnetBackend(candidate, storage)).toBe(false);
      expect(storage.getItem(occupiedKey)).toBe("exact opaque bytes");
      expect([...storage.values.keys()]).toEqual([occupiedKey]);
    }
  });

  it("refuses invalid first-run Tailnet candidates and storage read failures without writing", () => {
    const candidate = parseTailnetBackend("https://first.tailnet.ts.net:8445");
    const storage = new MemoryStorage();
    expect(writeFirstRunTailnetBackend({ ...candidate, label: "untrusted" }, storage)).toBe(false);
    expect(storage.values.size).toBe(0);

    const unreadable = {
      getItem: () => { throw new Error("private storage failure"); },
      setItem: () => { throw new Error("must not write"); },
    };
    expect(writeFirstRunTailnetBackend(candidate, unreadable)).toBe(false);
  });

  it.each([
    ["legacy v1", "t4-code:mobile-backend:v1", JSON.stringify(TEST_TAILNET)],
    ["peer v2", MOBILE_BACKEND_STORAGE_KEY, JSON.stringify(TEST_PEER)],
    ["Tailnet v2", MOBILE_BACKEND_STORAGE_KEY, JSON.stringify(TEST_TAILNET_DIRECTORY)],
    ["corrupt v2 bytes", MOBILE_BACKEND_STORAGE_KEY, "{not-json"],
    ["reserved v3", MOBILE_HOST_DIRECTORY_STORAGE_KEY, "v3 bytes"],
  ])("refuses first-run persistence when %s exists and preserves exact bytes", (_label, keyName, bytes) => {
    const storage = new MemoryStorage();
    const key = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    const peer = parsePeerBackend(`t4peer://v1/${key}/${key}`);
    storage.setItem(keyName, bytes);

    expect(writeFirstRunPeerBackend(peer, storage)).toBe(false);
    expect(storage.getItem(keyName)).toBe(bytes);
    expect([...storage.values.keys()]).toEqual([keyName]);
  });

  it("refuses first-run persistence after any storage read failure", () => {
    const key = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    const peer = parsePeerBackend(`t4peer://v1/${key}/${key}`);
    const values = new Map([["t4-code:mobile-backend:v1", "untouched"]]);
    const storage = {
      getItem: () => { throw new Error("storage unavailable"); },
      setItem: (name: string, value: string) => { values.set(name, value); },
      removeItem: (name: string) => { values.delete(name); },
    };

    expect(writeFirstRunPeerBackend(peer, storage)).toBe(false);
    expect(values).toEqual(new Map([["t4-code:mobile-backend:v1", "untouched"]]));
  });

  it("classifies only an entirely clean native store as first run", async () => {
    const storage = new MemoryStorage();
    Object.defineProperty(globalThis, "document", {
      configurable: true,
      value: { documentElement: { dataset: {} } },
    });
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        localStorage: storage,
        Capacitor: { isNativePlatform: () => true, getPlatform: () => "android" },
      },
    });

    await expect(prepareNativeMobileBackend()).resolves.toEqual({ kind: "setup", mode: "first-run" });
    storage.setItem(MOBILE_HOST_DIRECTORY_STORAGE_KEY, "opaque-v3");
    await expect(prepareNativeMobileBackend()).resolves.toEqual({
      kind: "setup",
      mode: "repair",
      repairAction: "upgrade",
      message: "A newer saved host directory is present but is not available in this build.",
    });
  });

  it("classifies corrupt existing bytes as controlled Tailnet repair without leaking bytes", async () => {
    const storage = new MemoryStorage();
    storage.setItem(MOBILE_BACKEND_STORAGE_KEY, "{secret-/private/path");
    Object.defineProperty(globalThis, "document", {
      configurable: true,
      value: { documentElement: { dataset: {} } },
    });
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        localStorage: storage,
        Capacitor: { isNativePlatform: () => true, getPlatform: () => "android" },
      },
    });

    const result = await prepareNativeMobileBackend();
    expect(result).toEqual({
      kind: "setup",
      mode: "repair",
      repairAction: "tailnet",
      message: "The saved connection cannot be opened. You can replace it with a verified Tailnet address.",
    });
    expect(JSON.stringify(result)).not.toContain("secret-/private/path");
  });

  it("obtains only the app-registered T4 QR scanner plugin", () => {
    const plugin = { marker: "registered" };
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: { Capacitor: { Plugins: { T4QrScanner: plugin } } },
    });

    expect(nativeQrScanner()).toBe(plugin);
  });

  it("normalizes a full Tailnet HTTPS origin and rejects unsafe addresses", () => {
    expect(parseTailnetBackend("lycaon-bunker.tail9f9e1a.ts.net:8445")).toEqual({
      version: 1,
      origin: "https://lycaon-bunker.tail9f9e1a.ts.net:8445",
      wsUrl: "wss://lycaon-bunker.tail9f9e1a.ts.net:8445/v1/ws",
      label: "T4 on lycaon-bunker",
    });
    expect(() => parseTailnetBackend("http://host.tailnet.ts.net")).toThrow(/HTTPS/u);
    expect(() => parseTailnetBackend("https://example.com")).toThrow(/\.ts\.net/u);
    expect(() => parseTailnetBackend("https://host.tailnet.ts.net/admin")).toThrow(/host address only/u);
    expect(() => parseTailnetBackend("https://user:pass@host.tailnet.ts.net")).toThrow(/credentials/u);
  });

  it("migrates the legacy host, retains added hosts, and switches without deleting either", () => {
    const storage = new MemoryStorage();
    const bunker = parseTailnetBackend("https://bunker.tailnet.ts.net:8445");
    const laptop = parseTailnetBackend("https://laptop.tailnet.ts.net:8445");
    storage.setItem("t4-code:mobile-backend:v1", JSON.stringify(bunker));

    expect(readStoredMobileBackendDirectory(storage)).toEqual({
      version: 2,
      activeOrigin: bunker.origin,
      backends: [bunker],
    });
    writeStoredMobileBackend(laptop, storage);
    expect(storage.getItem("t4-code:mobile-backend:v1")).toBeNull();
    expect(readStoredMobileBackendDirectory(storage)).toEqual({
      version: 2,
      activeOrigin: laptop.origin,
      backends: [bunker, laptop],
    });

    selectStoredMobileBackend(bunker.origin, storage);
    expect(readStoredMobileBackend(storage)).toEqual(bunker);
    expect(readStoredMobileBackendDirectory(storage)?.backends).toEqual([bunker, laptop]);

    storage.setItem(
      MOBILE_BACKEND_STORAGE_KEY,
      JSON.stringify({
        version: 2,
        activeOrigin: bunker.origin,
        backends: [{ ...bunker, wsUrl: "wss://evil.example/v1/ws" }],
      }),
    );
    expect(() => readStoredMobileBackend(storage)).toThrow(/inconsistent/u);
    replaceStoredMobileBackend(laptop, storage);
    expect(readStoredMobileBackendDirectory(storage)).toEqual({
      version: 2,
      activeOrigin: laptop.origin,
      backends: [laptop],
    });
  });

  it("stores a validated private peer invite without treating it as a Tailnet address", () => {
    const storage = new MemoryStorage();
    const key = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    const backend = parsePeerBackend(`t4peer://v1/${key}/${key}`);
    writeStoredPeerBackend(backend, storage);

    expect(readStoredMobileConnection(storage)).toEqual(backend);
    expect(() => readStoredMobileBackend(storage)).toThrow(/private/u);
  });

  it("loads only the active host credential from the keyed native bridge", async () => {
    const storage = new MemoryStorage();
    const backend = parseTailnetBackend("https://host.tailnet.ts.net:8445");
    storage.setItem("t4-code:mobile-backend:v1", JSON.stringify(backend));
    const reads: Array<{ readonly hostKey: string; readonly migrateLegacy?: boolean }> = [];
    const clears: string[] = [];
    Object.defineProperty(globalThis, "document", {
      configurable: true,
      value: { documentElement: { dataset: {} } },
    });
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        localStorage: storage,
        Capacitor: {
          isNativePlatform: () => true,
          getPlatform: () => "android",
          Plugins: {
            T4SecureStorage: {
              getCredentials: (options: {
                readonly hostKey: string;
                readonly migrateLegacy?: boolean;
              }) => {
                reads.push(options);
                return Promise.resolve({
                  credentials: {
                    deviceId: "android-device",
                    deviceToken: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
                  },
                });
              },
              setCredentials: () => Promise.resolve(),
              clearCredentials: ({ hostKey }: { readonly hostKey: string }) => {
                clears.push(hostKey);
                return Promise.resolve();
              },
            },
          },
        },
      },
    });

    await expect(prepareNativeMobileBackend()).resolves.toEqual({ kind: "ready", backend });
    expect(reads).toEqual([{ hostKey: backend.origin, migrateLegacy: true }]);
    expect(clears).toEqual([]);
    expect(window.__t4MobileBackend).toEqual({
      origin: backend.origin,
      wsUrl: backend.wsUrl,
      label: backend.label,
      deviceId: "android-device",
      deviceToken: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    });
    expect(storage.getItem("t4-code:mobile-backend:v1")).toBeNull();
    expect(storage.getItem(MOBILE_BACKEND_STORAGE_KEY)).toBeNull();
    expect(storage.getItem(MOBILE_HOST_DIRECTORY_STORAGE_KEY)).not.toBeNull();
  });

  it("migrates a legacy credential to its canonical origin before metadata and reuses it for that active host", async () => {
    const storage = new TrackingMemoryStorage();
    const backend = parseTailnetBackend("https://legacy.tailnet.ts.net:8445");
    storage.setItem("t4-code:mobile-backend:v1", JSON.stringify(backend));
    storage.operations.length = 0;
    const events: string[] = [];
    installNativeWindow(storage, {
      getCredentials: (options: { readonly hostKey: string; readonly migrateLegacy?: boolean }) => {
        events.push(`secure:${options.hostKey}:${String(options.migrateLegacy)}`);
        return Promise.resolve({ credentials: {
          deviceId: "android-device",
          deviceToken: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        } });
      },
      setCredentials: () => Promise.resolve(),
      clearCredentials: () => { events.push("clear"); return Promise.resolve(); },
    });
    const originalSet = storage.setItem.bind(storage);
    storage.setItem = (key, value) => { events.push(`set:${key}`); originalSet(key, value); };

    await expect(prepareNativeMobileBackend()).resolves.toEqual({ kind: "ready", backend });
    expect(events[0]).toBe(`secure:${backend.origin}:true`);
    expect(events).toContain(`set:${MOBILE_HOST_DIRECTORY_STORAGE_KEY}`);
    expect(events).not.toContain("clear");
    expect(storage.getItem("t4-code:mobile-backend:v1")).toBeNull();
    expect(storage.getItem(MOBILE_HOST_DIRECTORY_STORAGE_KEY)).not.toBeNull();
    expect(window.__t4MobileBackend).toMatchObject({
      origin: backend.origin,
      deviceId: "android-device",
      deviceToken: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    });
  });

  it("migrates only distinct legacy credential provenance and never applies it to the active v2 Tailnet host", async () => {
    const storage = new MemoryStorage();
    const active = parseTailnetBackend("https://active.tailnet.ts.net:8445");
    const legacy = parseTailnetBackend("https://legacy.tailnet.ts.net:8445");
    storage.setItem(MOBILE_BACKEND_STORAGE_KEY, JSON.stringify({ version: 2, activeOrigin: active.origin, backends: [active] }));
    storage.setItem("t4-code:mobile-backend:v1", JSON.stringify(legacy));
    const reads: unknown[] = [];
    const clears: unknown[] = [];
    installNativeWindow(storage, {
      getCredentials: (options: unknown) => {
        reads.push(options);
        return Promise.resolve({ credentials: {
          deviceId: "legacy-device",
          deviceToken: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        } });
      },
      setCredentials: () => Promise.resolve(),
      clearCredentials: (options: unknown) => { clears.push(options); return Promise.resolve(); },
    });

    await expect(prepareNativeMobileBackend()).resolves.toEqual({ kind: "ready", backend: active });
    expect(reads).toEqual([{ hostKey: legacy.origin, migrateLegacy: true }]);
    expect(clears).toEqual([]);
    expect(window.__t4MobileBackend).toEqual({ origin: active.origin, wsUrl: active.wsUrl, label: active.label });
  });

  it("boots a pending HyperDHT candidate without secure storage while preserving every source byte for retry", async () => {
    const storage = new MemoryStorage();
    const peer = TEST_PEER;
    const legacy = parseTailnetBackend("https://legacy.tailnet.ts.net:8445");
    const v2Raw = JSON.stringify(peer);
    const legacyRaw = JSON.stringify(legacy);
    storage.setItem(MOBILE_BACKEND_STORAGE_KEY, v2Raw);
    storage.setItem("t4-code:mobile-backend:v1", legacyRaw);
    installNativeWindow(storage);

    await expect(prepareNativeMobileBackend()).resolves.toEqual({ kind: "ready", backend: peer });
    expect(storage.getItem(MOBILE_BACKEND_STORAGE_KEY)).toBe(v2Raw);
    expect(storage.getItem("t4-code:mobile-backend:v1")).toBe(legacyRaw);
    expect(storage.getItem(MOBILE_HOST_DIRECTORY_STORAGE_KEY)).toBeNull();
  });

  it.each(["rejection", "invalid"] as const)(
    "boots pending HyperDHT after secure plugin %s while preserving exact source bytes and never clearing",
    async (failure) => {
      const storage = new MemoryStorage();
      const legacy = parseTailnetBackend("https://legacy.tailnet.ts.net:8445");
      const v2Raw = JSON.stringify(TEST_PEER);
      const legacyRaw = JSON.stringify(legacy);
      storage.setItem(MOBILE_BACKEND_STORAGE_KEY, v2Raw);
      storage.setItem("t4-code:mobile-backend:v1", legacyRaw);
      let clears = 0;
      installNativeWindow(storage, {
        getCredentials: () => failure === "rejection"
          ? Promise.reject(new Error("private plugin failure"))
          : Promise.resolve({ credentials: { deviceId: "", deviceToken: "invalid" } }),
        setCredentials: () => Promise.resolve(),
        clearCredentials: () => { clears += 1; return Promise.resolve(); },
      });

      await expect(prepareNativeMobileBackend()).resolves.toEqual({ kind: "ready", backend: TEST_PEER });
      expect(window.__t4MobileBackend).toBeUndefined();
      expect(window.__t4MobilePeerInvite).toBe(TEST_PEER.invite);
      expect(storage.getItem(MOBILE_BACKEND_STORAGE_KEY)).toBe(v2Raw);
      expect(storage.getItem("t4-code:mobile-backend:v1")).toBe(legacyRaw);
      expect(storage.getItem(MOBILE_HOST_DIRECTORY_STORAGE_KEY)).toBeNull();
      expect(clears).toBe(0);
    },
  );

  it("migrates peer-active legacy credentials at the legacy scope and discards them from the peer projection", async () => {
    const storage = new MemoryStorage();
    const legacy = parseTailnetBackend("https://legacy.tailnet.ts.net:8445");
    storage.setItem(MOBILE_BACKEND_STORAGE_KEY, JSON.stringify(TEST_PEER));
    storage.setItem("t4-code:mobile-backend:v1", JSON.stringify(legacy));
    const reads: unknown[] = [];
    installNativeWindow(storage, {
      getCredentials: (options: unknown) => {
        reads.push(options);
        return Promise.resolve({ credentials: {
          deviceId: "legacy-device",
          deviceToken: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        } });
      },
      setCredentials: () => Promise.resolve(),
      clearCredentials: () => Promise.resolve(),
    });

    await expect(prepareNativeMobileBackend()).resolves.toEqual({ kind: "ready", backend: TEST_PEER });
    expect(reads).toEqual([{ hostKey: legacy.origin, migrateLegacy: true }]);
    expect(window.__t4MobileBackend).toBeUndefined();
    expect(window.__t4MobilePeerInvite).toBe(TEST_PEER.invite);
    expect(storage.getItem(MOBILE_BACKEND_STORAGE_KEY)).toBeNull();
    expect(storage.getItem("t4-code:mobile-backend:v1")).toBeNull();
    expect(storage.getItem(MOBILE_HOST_DIRECTORY_STORAGE_KEY)).not.toBeNull();
  });

  it.each(["rejection", "invalid"] as const)(
    "preserves exact v2-only Tailscale bytes and never clears after plugin %s",
    async (failure) => {
      const storage = new MemoryStorage();
      const backend = parseTailnetBackend("https://active.tailnet.ts.net:8445");
      const v2Raw = JSON.stringify({ version: 2, activeOrigin: backend.origin, backends: [backend] });
      storage.setItem(MOBILE_BACKEND_STORAGE_KEY, v2Raw);
      let clears = 0;
      installNativeWindow(storage, {
        getCredentials: () => failure === "rejection"
          ? Promise.reject(new Error("private plugin failure"))
          : Promise.resolve({ credentials: { deviceId: "", deviceToken: "invalid" } }),
        setCredentials: () => Promise.resolve(),
        clearCredentials: () => { clears += 1; return Promise.resolve(); },
      });

      await expect(prepareNativeMobileBackend()).resolves.toEqual({ kind: "ready", backend });
      expect(window.__t4MobileBackend).toEqual({ origin: backend.origin, wsUrl: backend.wsUrl, label: backend.label });
      expect(storage.getItem("t4-code:mobile-backend:v1")).toBeNull();
      expect(storage.getItem(MOBILE_BACKEND_STORAGE_KEY)).toBe(v2Raw);
      expect(storage.getItem(MOBILE_HOST_DIRECTORY_STORAGE_KEY)).toBeNull();
      expect(clears).toBe(0);
    },
  );

  it("returns controlled repair for pending Tailscale when secure storage is absent without changing bytes", async () => {
    const storage = new MemoryStorage();
    const backend = parseTailnetBackend("https://legacy.tailnet.ts.net:8445");
    const raw = JSON.stringify(backend);
    storage.setItem("t4-code:mobile-backend:v1", raw);
    installNativeWindow(storage);

    const result = await prepareNativeMobileBackend();
    expect(result).toMatchObject({ kind: "setup", mode: "repair", repairAction: "unavailable" });
    expect(storage.getItem("t4-code:mobile-backend:v1")).toBe(raw);
    expect(storage.getItem(MOBILE_HOST_DIRECTORY_STORAGE_KEY)).toBeNull();
  });

  it("boots pending Tailscale without credentials after migration read failure and preserves bytes without clearing", async () => {
    const storage = new MemoryStorage();
    const backend = parseTailnetBackend("https://legacy.tailnet.ts.net:8445");
    const raw = JSON.stringify(backend);
    storage.setItem("t4-code:mobile-backend:v1", raw);
    let clears = 0;
    installNativeWindow(storage, {
      getCredentials: () => Promise.reject(new Error("private native failure")),
      setCredentials: () => Promise.resolve(),
      clearCredentials: () => { clears += 1; return Promise.resolve(); },
    });

    await expect(prepareNativeMobileBackend()).resolves.toEqual({ kind: "ready", backend });
    expect(window.__t4MobileBackend).toEqual({ origin: backend.origin, wsUrl: backend.wsUrl, label: backend.label });
    expect(storage.getItem("t4-code:mobile-backend:v1")).toBe(raw);
    expect(storage.getItem(MOBILE_HOST_DIRECTORY_STORAGE_KEY)).toBeNull();
    expect(clears).toBe(0);
  });

  it("treats an existing v3 directory as authoritative without secure migration or source cleanup", async () => {
    const storage = new TrackingMemoryStorage();
    const backend = parseTailnetBackend("https://existing.tailnet.ts.net:8445");
    const directory = {
      version: 3,
      activeHostId: "host_AAAAAAAAAAA",
      hosts: [{
        id: "host_AAAAAAAAAAA", label: backend.label,
        transports: [{ id: "tail_AAAAAAAAAAA", kind: "tailscale", origin: backend.origin, wsUrl: backend.wsUrl, displayAddress: backend.origin, credentialScopeKey: backend.origin }],
        preferredTransportIds: ["tail_AAAAAAAAAAA"], lastConnection: null,
      }],
    };
    const v3Raw = JSON.stringify(directory);
    const legacyRaw = JSON.stringify(parseTailnetBackend("https://unrelated.tailnet.ts.net:8445"));
    storage.setItem(MOBILE_HOST_DIRECTORY_STORAGE_KEY, v3Raw);
    storage.setItem("t4-code:mobile-backend:v1", legacyRaw);
    storage.operations.length = 0;
    let secureCalls = 0;
    installNativeWindow(storage, {
      getCredentials: () => { secureCalls += 1; return Promise.resolve({ credentials: null }); },
      setCredentials: () => Promise.resolve(),
      clearCredentials: () => { secureCalls += 1; return Promise.resolve(); },
    });

    await expect(prepareNativeMobileBackend()).resolves.toEqual({ kind: "ready", backend });
    expect(secureCalls).toBe(0);
    expect(storage.getItem(MOBILE_HOST_DIRECTORY_STORAGE_KEY)).toBe(v3Raw);
    expect(storage.getItem("t4-code:mobile-backend:v1")).toBe(legacyRaw);
    expect(storage.operations.every((operation) => !operation.startsWith("remove:"))).toBe(true);
  });

  it("treats existing v3 plus matching legacy as authoritative without secure calls or cleanup", async () => {
    const storage = new TrackingMemoryStorage();
    const backend = parseTailnetBackend("https://matching.tailnet.ts.net:8445");
    const v3Raw = JSON.stringify({
      version: 3,
      activeHostId: "host_AAAAAAAAAAA",
      hosts: [{
        id: "host_AAAAAAAAAAA", label: backend.label,
        transports: [{ id: "tail_AAAAAAAAAAA", kind: "tailscale", origin: backend.origin, wsUrl: backend.wsUrl, displayAddress: backend.origin, credentialScopeKey: backend.origin }],
        preferredTransportIds: ["tail_AAAAAAAAAAA"], lastConnection: null,
      }],
    });
    const legacyRaw = JSON.stringify(backend);
    storage.setItem(MOBILE_HOST_DIRECTORY_STORAGE_KEY, v3Raw);
    storage.setItem("t4-code:mobile-backend:v1", legacyRaw);
    storage.operations.length = 0;
    let secureCalls = 0;
    installNativeWindow(storage, {
      getCredentials: () => { secureCalls += 1; return Promise.resolve({ credentials: null }); },
      setCredentials: () => Promise.resolve(),
      clearCredentials: () => { secureCalls += 1; return Promise.resolve(); },
    });

    await expect(prepareNativeMobileBackend()).resolves.toEqual({ kind: "ready", backend });
    expect(secureCalls).toBe(0);
    expect(storage.getItem(MOBILE_HOST_DIRECTORY_STORAGE_KEY)).toBe(v3Raw);
    expect(storage.getItem("t4-code:mobile-backend:v1")).toBe(legacyRaw);
    expect(storage.operations.every((operation) => !operation.startsWith("remove:"))).toBe(true);
  });

  it("treats existing v3 plus remaining v2 as authoritative after partial cleanup", async () => {
    const storage = new TrackingMemoryStorage();
    const backend = parseTailnetBackend("https://partial.tailnet.ts.net:8445");
    const v3Raw = JSON.stringify({
      version: 3,
      activeHostId: "host_AAAAAAAAAAA",
      hosts: [{
        id: "host_AAAAAAAAAAA", label: backend.label,
        transports: [{ id: "tail_AAAAAAAAAAA", kind: "tailscale", origin: backend.origin, wsUrl: backend.wsUrl, displayAddress: backend.origin, credentialScopeKey: backend.origin }],
        preferredTransportIds: ["tail_AAAAAAAAAAA"], lastConnection: null,
      }],
    });
    const v2Raw = JSON.stringify({ version: 2, activeOrigin: backend.origin, backends: [backend] });
    storage.setItem(MOBILE_HOST_DIRECTORY_STORAGE_KEY, v3Raw);
    storage.setItem(MOBILE_BACKEND_STORAGE_KEY, v2Raw);
    storage.operations.length = 0;
    installNativeWindow(storage);

    await expect(prepareNativeMobileBackend()).resolves.toEqual({ kind: "ready", backend });
    expect(storage.getItem(MOBILE_HOST_DIRECTORY_STORAGE_KEY)).toBe(v3Raw);
    expect(storage.getItem(MOBILE_BACKEND_STORAGE_KEY)).toBe(v2Raw);
    expect(storage.operations.every((operation) => !operation.startsWith("remove:"))).toBe(true);
  });

  it("does not rebind global legacy credentials after v2 host repair", async () => {
    const storage = new MemoryStorage();
    const backend = parseTailnetBackend("https://repaired.tailnet.ts.net:8445");
    replaceStoredMobileBackend(backend, storage);
    const reads: Array<{ readonly hostKey: string; readonly migrateLegacy?: boolean }> = [];
    Object.defineProperty(globalThis, "document", {
      configurable: true,
      value: { documentElement: { dataset: {} } },
    });
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        localStorage: storage,
        Capacitor: {
          isNativePlatform: () => true,
          getPlatform: () => "android",
          Plugins: {
            T4SecureStorage: {
              getCredentials: (options: {
                readonly hostKey: string;
                readonly migrateLegacy?: boolean;
              }) => {
                reads.push(options);
                return Promise.resolve({ credentials: null });
              },
              setCredentials: () => Promise.resolve(),
              clearCredentials: () => Promise.resolve(),
            },
          },
        },
      },
    });

    await expect(prepareNativeMobileBackend()).resolves.toEqual({ kind: "ready", backend });
    expect(reads).toEqual([{ hostKey: backend.origin, migrateLegacy: false }]);
  });

  it("renders setup instead of rejecting when host storage is unavailable", async () => {
    Object.defineProperty(globalThis, "document", {
      configurable: true,
      value: { documentElement: { dataset: {} } },
    });
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        localStorage: {
          getItem: () => {
            throw new Error("Host storage is unavailable.");
          },
        },
        Capacitor: {
          isNativePlatform: () => true,
          getPlatform: () => "android",
        },
      },
    });

    await expect(prepareNativeMobileBackend()).resolves.toEqual({
      kind: "setup",
      mode: "repair",
      repairAction: "unavailable",
      message: "T4 Code cannot read saved connection storage. Close and reopen the app, then check system storage settings.",
    });
  });

  it("stores and removes credentials for exactly the selected host", async () => {
    const storage = new MemoryStorage();
    const bunker = parseTailnetBackend("https://bunker.tailnet.ts.net:8445");
    const laptop = parseTailnetBackend("https://laptop.tailnet.ts.net:8445");
    writeStoredMobileBackend(bunker, storage);
    writeStoredMobileBackend(laptop, storage);
    selectStoredMobileBackend(bunker.origin, storage);

    const writes: Array<{
      readonly hostKey: string;
      readonly deviceId: string;
      readonly deviceToken: string;
    }> = [];
    const clears: string[] = [];
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        localStorage: storage,
        __t4MobileBackend: { origin: bunker.origin, wsUrl: bunker.wsUrl, label: bunker.label },
        Capacitor: {
          isNativePlatform: () => true,
          getPlatform: () => "android",
          Plugins: {
            T4SecureStorage: {
              getCredentials: () => Promise.resolve({ credentials: null }),
              setCredentials: (value: {
                readonly hostKey: string;
                readonly deviceId: string;
                readonly deviceToken: string;
              }) => {
                writes.push(value);
                return Promise.resolve();
              },
              clearCredentials: ({ hostKey }: { readonly hostKey: string }) => {
                clears.push(hostKey);
                return Promise.resolve();
              },
            },
          },
        },
      },
    });

    await persistNativeMobileCredentials({
      deviceId: "bunker-device",
      deviceToken: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    });
    expect(writes).toEqual([
      {
        hostKey: bunker.origin,
        deviceId: "bunker-device",
        deviceToken: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      },
    ]);

    await removeNativeMobileBackend(laptop.origin, storage);
    expect(clears).toEqual([laptop.origin]);
    expect(readStoredMobileBackendDirectory(storage)).toEqual({
      version: 2,
      activeOrigin: bunker.origin,
      backends: [bunker],
    });
    expect(window.__t4MobileBackend?.origin).toBe(bunker.origin);
  });

  it("restores the complete host directory when secure credential removal fails", async () => {
    const storage = new MemoryStorage();
    const bunker = parseTailnetBackend("https://bunker.tailnet.ts.net:8445");
    const laptop = parseTailnetBackend("https://laptop.tailnet.ts.net:8445");
    writeStoredMobileBackend(bunker, storage);
    writeStoredMobileBackend(laptop, storage);
    let directoryDuringClear: StoredMobileBackendDirectory | null = null;
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        localStorage: storage,
        __t4MobileBackend: { origin: laptop.origin, wsUrl: laptop.wsUrl, label: laptop.label },
        Capacitor: {
          isNativePlatform: () => true,
          getPlatform: () => "android",
          Plugins: {
            T4SecureStorage: {
              getCredentials: () => Promise.resolve({ credentials: null }),
              setCredentials: () => Promise.resolve(),
              clearCredentials: () => {
                directoryDuringClear = readStoredMobileBackendDirectory(storage);
                return Promise.reject(new Error("secure storage failed"));
              },
            },
          },
        },
      },
    });

    await expect(removeNativeMobileBackend(laptop.origin, storage)).rejects.toThrow(
      "secure storage failed",
    );
    expect(directoryDuringClear).toEqual({
      version: 2,
      activeOrigin: bunker.origin,
      backends: [bunker],
    });
    expect(readStoredMobileBackendDirectory(storage)).toEqual({
      version: 2,
      activeOrigin: laptop.origin,
      backends: [bunker, laptop],
    });
    expect(window.__t4MobileBackend?.origin).toBe(laptop.origin);
  });

  it("removing the active host selects a retained host, then removing the last enters setup", async () => {
    const storage = new MemoryStorage();
    const bunker = parseTailnetBackend("https://bunker.tailnet.ts.net:8445");
    const laptop = parseTailnetBackend("https://laptop.tailnet.ts.net:8445");
    writeStoredMobileBackend(bunker, storage);
    writeStoredMobileBackend(laptop, storage);
    const clears: string[] = [];
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        localStorage: storage,
        __t4MobileBackend: { origin: laptop.origin, wsUrl: laptop.wsUrl, label: laptop.label },
        Capacitor: {
          isNativePlatform: () => true,
          getPlatform: () => "android",
          Plugins: {
            T4SecureStorage: {
              getCredentials: () => Promise.resolve({ credentials: null }),
              setCredentials: () => Promise.resolve(),
              clearCredentials: ({ hostKey }: { readonly hostKey: string }) => {
                clears.push(hostKey);
                return Promise.resolve();
              },
            },
          },
        },
      },
    });

    await removeNativeMobileBackend(laptop.origin, storage);
    expect(readStoredMobileBackend(storage)).toEqual(bunker);
    expect(window.__t4MobileBackend).toBeUndefined();
    await removeNativeMobileBackend(bunker.origin, storage);
    expect(readStoredMobileBackendDirectory(storage)).toBeNull();
    expect(storage.getItem(MOBILE_BACKEND_STORAGE_KEY)).toBeNull();
    expect(clears).toEqual([laptop.origin, bunker.origin]);
  });

  it("probes the exact WSS endpoint before saving", async () => {
    class OpeningSocket {
      static url = "";
      readonly listeners = new Map<string, Set<() => void>>();
      constructor(url: string | URL) {
        OpeningSocket.url = String(url);
        queueMicrotask(() => this.emit("open"));
      }
      addEventListener(name: string, listener: () => void): void {
        const listeners = this.listeners.get(name) ?? new Set();
        listeners.add(listener);
        this.listeners.set(name, listeners);
      }
      removeEventListener(name: string, listener: () => void): void { this.listeners.get(name)?.delete(listener); }
      close(): void {}
      private emit(name: string): void { for (const listener of this.listeners.get(name) ?? []) listener(); }
    }
    const backend = parseTailnetBackend("https://host.tailnet.ts.net:8445");
    await expect(probeMobileBackend(backend, { WebSocketImpl: OpeningSocket as unknown as typeof WebSocket })).resolves.toBeUndefined();
    expect(OpeningSocket.url).toBe(backend.wsUrl);
  });

  it("aborts an in-flight probe and closes its socket", async () => {
    class HangingSocket {
      static instance: HangingSocket | undefined;
      readonly listeners = new Map<string, Set<() => void>>();
      closed = false;
      constructor() {
        HangingSocket.instance = this;
      }
      addEventListener(name: string, listener: () => void): void {
        const listeners = this.listeners.get(name) ?? new Set();
        listeners.add(listener);
        this.listeners.set(name, listeners);
      }
      removeEventListener(name: string, listener: () => void): void {
        this.listeners.get(name)?.delete(listener);
      }
      close(): void {
        this.closed = true;
      }
    }
    const controller = new AbortController();
    const backend = parseTailnetBackend("https://host.tailnet.ts.net:8445");
    const probe = probeMobileBackend(backend, {
      signal: controller.signal,
      WebSocketImpl: HangingSocket as unknown as typeof WebSocket,
    });

    controller.abort();

    await expect(probe).rejects.toMatchObject({ name: "AbortError" });
    expect(HangingSocket.instance?.closed).toBe(true);
  });

  it("renders focused first-run instructions instead of fixture sessions", () => {
    const markup = renderToStaticMarkup(<MobileConnectionScreen mode="first-run" />);
    expect(markup).toContain("Connect to your T4 host");
    expect(markup).toContain("Checking camera");
    expect(markup).toContain("Paste private key");
    expect(markup).not.toContain("Use Tailscale address");
    expect(markup).toContain("Open Tailscale on this phone");
    expect(markup).toContain("h-12 w-full");
    expect(markup).not.toContain("Sample data");
  });

  it("keeps private-key persistence actions out of repair mode", () => {
    const markup = renderToStaticMarkup(
      <MobileConnectionScreen mode="repair" repairAction="tailnet" startupMessage="Saved state needs attention." />,
    );
    expect(markup).toContain("Repair your saved connection");
    expect(markup).toContain("Repair with Tailnet");
    expect(markup).not.toContain("Scan QR code");
    expect(markup).not.toContain("Paste private key");
    expect(markup.match(/Saved state needs attention\./gu)).toHaveLength(1);
    expect(markup).not.toContain('aria-invalid="true"');
  });

  it.each(["upgrade", "unavailable"] as const)("renders bounded %s repair without destructive address actions", (repairAction) => {
    const message = repairAction === "upgrade"
      ? "A newer saved host directory is present but is not available in this build."
      : "T4 Code cannot read saved connection storage. Close and reopen the app, then check system storage settings.";
    const markup = renderToStaticMarkup(
      <MobileConnectionScreen mode="repair" repairAction={repairAction} startupMessage={message} />,
    );
    expect(markup).toContain(message);
    expect(markup).not.toContain("Repair with Tailnet");
    expect(markup).not.toContain(">Tailnet address</label>");
  });
});
