import { describe, expect, it } from "vite-plus/test";

import {
  buildMobileHostMigration,
  prepareMobileHostDirectoryLoad,
  readMobileHostDirectory,
  writeMobileHostDirectory,
} from "../src/platform/mobile-host-storage.ts";
import {
  StoredMobileDirectoryError,
  parseMobileHostDirectory,
  type MobileHostDirectory,
} from "../src/platform/mobile-host-schema.ts";

const STORAGE_KEY = "t4-code:mobile-hosts:v3";
const SECRET = "private-invite-secret";
const PUBLIC_KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const CAPABILITY = "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBA";
const INVITE = `t4peer://v1/${PUBLIC_KEY}/${CAPABILITY}`;

function canonicalDirectory() {
  const origin = "https://desk.tailnet.ts.net:8445";
  return {
    version: 3,
    activeHostId: "host_AAAAAAAAAAA",
    hosts: [{
      id: "host_AAAAAAAAAAA",
      label: "Desk",
      transports: [{
        id: "tail_AAAAAAAAAAA",
        kind: "tailscale",
        origin,
        wsUrl: "wss://desk.tailnet.ts.net:8445/v1/ws",
        displayAddress: origin,
        credentialScopeKey: origin,
      }],
      preferredTransportIds: ["tail_AAAAAAAAAAA"],
      lastConnection: null,
    }],
  };
}

function expectControlledReadError(read: () => unknown): void {
  let caught: unknown;
  try {
    read();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(StoredMobileDirectoryError);
  const message = caught instanceof Error ? caught.message : String(caught);
  expect(message).not.toContain(SECRET);
  expect(message).not.toContain(STORAGE_KEY);
}

function withWindowDescriptor<T>(
  descriptor: PropertyDescriptor | undefined,
  run: () => T,
): T {
  const original = Object.getOwnPropertyDescriptor(globalThis, "window");
  try {
    if (descriptor === undefined) {
      Reflect.deleteProperty(globalThis, "window");
    } else {
      Object.defineProperty(globalThis, "window", descriptor);
    }
    return run();
  } finally {
    if (original === undefined) {
      Reflect.deleteProperty(globalThis, "window");
    } else {
      Object.defineProperty(globalThis, "window", original);
    }
  }
}

function throwingLocalStorageWindow(): PropertyDescriptor {
  const value = Object.defineProperty({}, "localStorage", {
    get: () => {
      throw new Error(`${STORAGE_KEY}: ${SECRET}`);
    },
  });
  return { configurable: true, value };
}

describe("readMobileHostDirectory", () => {
  it("returns null when the v3 directory is absent", () => {
    const storage = { getItem: (_key: string) => null };

    expect(readMobileHostDirectory(storage)).toBeNull();
  });

  it("reads canonical JSON into a recursively frozen directory", () => {
    const raw = JSON.stringify(canonicalDirectory());
    const storage = { getItem: (key: string) => key === STORAGE_KEY ? raw : null };

    const result = readMobileHostDirectory(storage);

    expect(result).toEqual(canonicalDirectory());
    expect(result).not.toBeNull();
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result!.hosts)).toBe(true);
    expect(Object.isFrozen(result!.hosts[0])).toBe(true);
    expect(Object.isFrozen(result!.hosts[0]!.transports[0])).toBe(true);
  });

  it("maps corrupt JSON to a controlled error without exposing raw text", () => {
    const storage = { getItem: (_key: string) => `{"invite":"${SECRET}"` };

    expectControlledReadError(() => readMobileHostDirectory(storage));
  });

  it("maps invalid directory data to a controlled error without exposing values", () => {
    const storage = { getItem: (_key: string) => JSON.stringify({
      ...canonicalDirectory(),
      activeHostId: SECRET,
    }) };

    expectControlledReadError(() => readMobileHostDirectory(storage));
  });

  it("maps storage access failures to a controlled error without exposing details", () => {
    const storage = {
      getItem: (_key: string): string | null => {
        throw new Error(`${STORAGE_KEY}: ${SECRET}`);
      },
    };

    expectControlledReadError(() => readMobileHostDirectory(storage));
  });

  it("maps a missing browser window to a controlled error", () => {
    withWindowDescriptor(undefined, () => {
      expectControlledReadError(() => readMobileHostDirectory());
    });
  });

  it("maps a throwing localStorage getter to a controlled error without exposing details", () => {
    withWindowDescriptor(throwingLocalStorageWindow(), () => {
      expectControlledReadError(() => readMobileHostDirectory());
    });
  });
});

function expectControlledWriteError(write: () => unknown, forbidden: readonly string[]): void {
  let caught: unknown;
  try {
    write();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(StoredMobileDirectoryError);
  const message = caught instanceof Error ? caught.message : String(caught);
  for (const text of forbidden) expect(message).not.toContain(text);
}

describe("writeMobileHostDirectory", () => {
  it("rejects invalid input before calling setItem", () => {
    let writes = 0;
    const invalid = {
      ...canonicalDirectory(),
      activeHostId: SECRET,
    } as unknown as MobileHostDirectory;
    const storage = {
      setItem: (_key: string, _value: string) => {
        writes += 1;
      },
    };

    expectControlledWriteError(
      () => writeMobileHostDirectory(invalid, storage),
      [SECRET, STORAGE_KEY],
    );
    expect(writes).toBe(0);
  });

  it("writes the validated canonical directory exactly once", () => {
    const canonical = parseMobileHostDirectory(canonicalDirectory());
    const calls: Array<readonly [string, string]> = [];
    const storage = {
      setItem: (key: string, value: string) => {
        calls.push([key, value]);
      },
    };

    writeMobileHostDirectory(canonical, storage);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.[0]).toBe(STORAGE_KEY);
    expect(calls[0]?.[1]).toBe(JSON.stringify(canonical));
    expect(parseMobileHostDirectory(JSON.parse(calls[0]![1]))).toEqual(canonical);
  });

  it("maps setItem failures to a controlled error without exposing stored data", () => {
    const canonical = parseMobileHostDirectory(canonicalDirectory());
    const raw = JSON.stringify(canonical);
    const origin = canonical.hosts[0]!.transports[0]!.kind === "tailscale"
      ? canonical.hosts[0]!.transports[0]!.origin
      : "unreachable";
    const storage = {
      setItem: (_key: string, _value: string): void => {
        throw new Error(`${STORAGE_KEY}: ${SECRET}: ${origin}: ${raw}`);
      },
    };

    expectControlledWriteError(
      () => writeMobileHostDirectory(canonical, storage),
      [SECRET, STORAGE_KEY, origin, raw],
    );
  });

  it("maps a missing browser window to a controlled error", () => {
    const canonical = parseMobileHostDirectory(canonicalDirectory());

    withWindowDescriptor(undefined, () => {
      expectControlledWriteError(
        () => writeMobileHostDirectory(canonical),
        [SECRET, STORAGE_KEY],
      );
    });
  });

  it("maps a throwing localStorage getter to a controlled error without exposing details", () => {
    const canonical = parseMobileHostDirectory(canonicalDirectory());

    withWindowDescriptor(throwingLocalStorageWindow(), () => {
      expectControlledWriteError(
        () => writeMobileHostDirectory(canonical),
        [SECRET, STORAGE_KEY],
      );
    });
  });
});

function tailnet(name: string) {
  const origin = `https://${name}.tailnet.ts.net:8445`;
  return {
    version: 1,
    origin,
    wsUrl: `wss://${name}.tailnet.ts.net:8445/v1/ws`,
    label: `T4 on ${name}`,
  } as const;
}

function migrationIds() {
  const ids = {
    host: ["host_AAAAAAAAAAA", "host_BBBBBBBBBBB", "host_CCCCCCCCCCC"],
    tailscale: ["tail_AAAAAAAAAAA", "tail_BBBBBBBBBBB", "tail_CCCCCCCCCCC"],
    hyperdht: ["peer_AAAAAAAAAAA", "peer_BBBBBBBBBBB", "peer_CCCCCCCCCCC"],
  };
  return (kind: "host" | "tailscale" | "hyperdht") => ids[kind].shift()!;
}

function tailscaleHost(hostId: string, transportId: string, name: string) {
  const backend = tailnet(name);
  return {
    id: hostId,
    label: backend.label,
    transports: [{
      id: transportId,
      kind: "tailscale",
      origin: backend.origin,
      wsUrl: backend.wsUrl,
      displayAddress: backend.origin,
      credentialScopeKey: backend.origin,
    }],
    preferredTransportIds: [transportId],
    lastConnection: null,
  };
}

function expectCandidate(
  sources: { readonly legacyRaw: string | null; readonly v2Raw: string | null },
) {
  const original = { ...sources };
  const result = buildMobileHostMigration(sources, migrationIds());
  expect(sources).toEqual(original);
  expect(result.kind).toBe("candidate");
  if (result.kind !== "candidate") throw new Error("expected migration candidate");
  return result.directory;
}

describe("buildMobileHostMigration source mapping", () => {
  it("maps a lone legacy Tailnet record as the active host", () => {
    expect(expectCandidate({ legacyRaw: JSON.stringify(tailnet("legacy")), v2Raw: null })).toEqual({
      version: 3,
      activeHostId: "host_AAAAAAAAAAA",
      hosts: [tailscaleHost("host_AAAAAAAAAAA", "tail_AAAAAAAAAAA", "legacy")],
    });
  });

  it("retains v2 Tailnet order and the second active origin", () => {
    const first = tailnet("first");
    const second = tailnet("second");
    const v2Raw = JSON.stringify({ version: 2, activeOrigin: second.origin, backends: [first, second] });
    expect(expectCandidate({ legacyRaw: null, v2Raw })).toEqual({
      version: 3,
      activeHostId: "host_BBBBBBBBBBB",
      hosts: [
        tailscaleHost("host_AAAAAAAAAAA", "tail_AAAAAAAAAAA", "first"),
        tailscaleHost("host_BBBBBBBBBBB", "tail_BBBBBBBBBBB", "second"),
      ],
    });
  });

  it("does not emit a duplicate legacy Tailnet origin after v2", () => {
    const first = tailnet("first");
    const v2Raw = JSON.stringify({ version: 2, activeOrigin: first.origin, backends: [first] });
    expect(expectCandidate({ legacyRaw: JSON.stringify(first), v2Raw })).toEqual({
      version: 3,
      activeHostId: "host_AAAAAAAAAAA",
      hosts: [tailscaleHost("host_AAAAAAAAAAA", "tail_AAAAAAAAAAA", "first")],
    });
  });

  it("appends a distinct legacy Tailnet origin after v2 without changing the active host", () => {
    const first = tailnet("first");
    const legacy = tailnet("legacy");
    const v2Raw = JSON.stringify({ version: 2, activeOrigin: first.origin, backends: [first] });
    expect(expectCandidate({ legacyRaw: JSON.stringify(legacy), v2Raw })).toEqual({
      version: 3,
      activeHostId: "host_AAAAAAAAAAA",
      hosts: [
        tailscaleHost("host_AAAAAAAAAAA", "tail_AAAAAAAAAAA", "first"),
        tailscaleHost("host_BBBBBBBBBBB", "tail_BBBBBBBBBBB", "legacy"),
      ],
    });
  });

  it("maps a standalone v2 peer as one active HyperDHT host", () => {
    const peer = { version: 2, kind: "peer", invite: INVITE, label: "T4 private host AAAAAAAA" };
    expect(expectCandidate({ legacyRaw: null, v2Raw: JSON.stringify(peer) })).toEqual({
      version: 3,
      activeHostId: "host_AAAAAAAAAAA",
      hosts: [{
        id: "host_AAAAAAAAAAA",
        label: peer.label,
        transports: [{
          id: "peer_AAAAAAAAAAA",
          kind: "hyperdht",
          invite: INVITE,
          desktopFingerprint: "AAAAAAAA",
        }],
        preferredTransportIds: ["peer_AAAAAAAAAAA"],
        lastConnection: null,
      }],
    });
  });

  it("keeps a v2 peer active and appends a legacy Tailnet host without merging kinds", () => {
    const peer = { version: 2, kind: "peer", invite: INVITE, label: "T4 private host AAAAAAAA" };
    const directory = expectCandidate({ legacyRaw: JSON.stringify(tailnet("legacy")), v2Raw: JSON.stringify(peer) });
    expect(directory).toEqual({
      version: 3,
      activeHostId: "host_AAAAAAAAAAA",
      hosts: [{
        id: "host_AAAAAAAAAAA",
        label: peer.label,
        transports: [{
          id: "peer_AAAAAAAAAAA",
          kind: "hyperdht",
          invite: INVITE,
          desktopFingerprint: "AAAAAAAA",
        }],
        preferredTransportIds: ["peer_AAAAAAAAAAA"],
        lastConnection: null,
      }, tailscaleHost("host_BBBBBBBBBBB", "tail_AAAAAAAAAAA", "legacy")],
    });
  });

  it("requests each host ID immediately before that host's transport ID", () => {
    const peer = { version: 2, kind: "peer", invite: INVITE, label: "T4 private host AAAAAAAA" };
    const calls: Array<"host" | "tailscale" | "hyperdht"> = [];
    const ids = migrationIds();
    const result = buildMobileHostMigration(
      { legacyRaw: JSON.stringify(tailnet("legacy")), v2Raw: JSON.stringify(peer) },
      (kind) => {
        calls.push(kind);
        return ids(kind);
      },
    );
    expect(result.kind).toBe("candidate");
    expect(calls).toEqual(["host", "hyperdht", "host", "tailscale"]);
  });

  it("returns empty when both sources are absent", () => {
    expect(buildMobileHostMigration({ legacyRaw: null, v2Raw: null }, migrationIds())).toEqual({ kind: "empty" });
  });

  it.each([
    ["legacy", "{private-corrupt", JSON.stringify({ version: 2, activeOrigin: tailnet("valid").origin, backends: [tailnet("valid")] })],
    ["v2", JSON.stringify(tailnet("valid")), "{private-corrupt"],
  ])("returns controlled repair for corrupt %s bytes even when the other source is valid", (_source, legacyRaw, v2Raw) => {
    const sources = { legacyRaw, v2Raw };
    const result = buildMobileHostMigration(sources, migrationIds());
    expect(result.kind).toBe("repair");
    expect(result.kind === "repair" ? result.message : "").not.toContain("private-corrupt");
    expect(sources).toEqual({ legacyRaw, v2Raw });
  });
});

describe("buildMobileHostMigration generated IDs", () => {
  const twoTailnetSources = {
    legacyRaw: null,
    v2Raw: JSON.stringify({
      version: 2,
      activeOrigin: tailnet("first").origin,
      backends: [tailnet("first"), tailnet("second")],
    }),
  } as const;

  function expectControlledIdRepair(
    sources: { readonly legacyRaw: string | null; readonly v2Raw: string | null },
    nextId: (kind: "host" | "tailscale" | "hyperdht") => string,
  ): void {
    const original = { ...sources };
    const result = buildMobileHostMigration(sources, nextId);
    expect(result.kind).toBe("repair");
    expect(result.kind === "repair" ? result.message : "").toBe(
      "The saved mobile connection needs to be repaired before it can be migrated.",
    );
    expect(result.kind === "repair" ? result.message : "").not.toContain(SECRET);
    expect(sources).toEqual(original);
  }

  it("validates each generated ID before requesting another one", () => {
    const calls: string[] = [];
    expectControlledIdRepair(twoTailnetSources, (kind) => {
      calls.push(kind);
      return kind === "host" ? "invalid id" : "tail_AAAAAAAAAAA";
    });
    expect(calls).toEqual(["host"]);
  });

  it("rejects duplicate host IDs", () => {
    const ids = [
      "host_AAAAAAAAAAA", "tail_AAAAAAAAAAA",
      "host_AAAAAAAAAAA", "tail_BBBBBBBBBBB",
    ];
    expectControlledIdRepair(twoTailnetSources, () => ids.shift()!);
  });

  it("rejects a host and transport ID collision", () => {
    expectControlledIdRepair(
      { legacyRaw: JSON.stringify(tailnet("legacy")), v2Raw: null },
      () => "host_AAAAAAAAAAA",
    );
  });

  it("rejects duplicate transport IDs", () => {
    const ids = [
      "host_AAAAAAAAAAA", "tail_AAAAAAAAAAA",
      "host_BBBBBBBBBBB", "tail_AAAAAAAAAAA",
    ];
    expectControlledIdRepair(twoTailnetSources, () => ids.shift()!);
  });

  it("contains an ID factory exception without exposing its text", () => {
    expectControlledIdRepair(
      { legacyRaw: JSON.stringify(tailnet("legacy")), v2Raw: null },
      () => {
        throw new Error(`${SECRET}: /private/path`);
      },
    );
  });
});

const LEGACY_STORAGE_KEY = "t4-code:mobile-backend:v1";
const V2_STORAGE_KEY = "t4-code:mobile-backends:v2";

class ReadOnlyMigrationStorage {
  readonly reads: string[] = [];
  readonly mutations: string[] = [];
  readonly values: ReadonlyMap<string, string>;
  readonly throwingReadKey: string | null;

  constructor(
    values: ReadonlyMap<string, string>,
    throwingReadKey: string | null = null,
  ) {
    this.values = values;
    this.throwingReadKey = throwingReadKey;
  }

  getItem(key: string): string | null {
    this.reads.push(key);
    if (key === this.throwingReadKey) throw new Error(`${SECRET}: ${key}`);
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.mutations.push(`set:${key}:${value}`);
    throw new Error("preparation must not write");
  }

  removeItem(key: string): void {
    this.mutations.push(`remove:${key}`);
    throw new Error("preparation must not remove");
  }
}

function prepareFrom(
  values: ReadonlyMap<string, string>,
  throwingReadKey: string | null = null,
) {
  const storage = new ReadOnlyMigrationStorage(values, throwingReadKey);
  const result = prepareMobileHostDirectoryLoad(storage, migrationIds());
  expect(storage.mutations).toEqual([]);
  return { result, storage };
}

function expectSafePreparationShape(value: unknown): void {
  const record = value as Record<string, unknown>;
  expect(Object.keys(record)).not.toContain("v2Raw");
  expect(Object.keys(record)).not.toContain("legacyRaw");
  expect(Object.keys(record)).not.toContain("candidateRaw");
  const serialized = JSON.stringify(value);
  expect(serialized).not.toContain("v2Raw");
  expect(serialized).not.toContain("legacyRaw");
  expect(serialized).not.toContain("candidateRaw");
}

describe("prepareMobileHostDirectoryLoad", () => {
  it("returns an existing valid v3 directory without reading or exposing legacy provenance", () => {
    const raw = JSON.stringify(canonicalDirectory());
    const values = new Map([
      [STORAGE_KEY, raw],
      [V2_STORAGE_KEY, JSON.stringify({ version: 2, kind: "peer", invite: INVITE, label: "T4 private host AAAAAAAA" })],
      [LEGACY_STORAGE_KEY, JSON.stringify(tailnet("desk"))],
    ]);

    const { result, storage } = prepareFrom(values);

    expect(result).toEqual({
      kind: "existing",
      directory: parseMobileHostDirectory(canonicalDirectory()),
    });
    expect(storage.reads).toEqual([STORAGE_KEY]);
    expect("legacyOrigin" in result).toBe(false);
    expectSafePreparationShape(result);
  });

  it("does not inspect unrelated valid legacy bytes when a valid v3 directory exists", () => {
    const unrelatedLegacy = JSON.stringify(tailnet("unrelated"));
    const values = new Map([
      [STORAGE_KEY, JSON.stringify(canonicalDirectory())],
      [LEGACY_STORAGE_KEY, unrelatedLegacy],
    ]);
    const storage = new ReadOnlyMigrationStorage(values, LEGACY_STORAGE_KEY);

    const result = prepareMobileHostDirectoryLoad(storage, () => {
      throw new Error("existing v3 must not request migration IDs");
    });

    expect(result.kind).toBe("existing");
    expect(storage.reads).toEqual([STORAGE_KEY]);
    expect(storage.mutations).toEqual([]);
    expect("legacyOrigin" in result).toBe(false);
  });

  it("returns controlled repair for corrupt v3 without reading sources or changing any bytes", () => {
    const corrupt = `{"invite":"${SECRET}"`;
    const { result, storage } = prepareFrom(new Map([
      [STORAGE_KEY, corrupt],
      [V2_STORAGE_KEY, JSON.stringify({ version: 2, kind: "peer", invite: INVITE, label: "T4 private host AAAAAAAA" })],
      [LEGACY_STORAGE_KEY, JSON.stringify(tailnet("legacy"))],
    ]));

    expect(result).toEqual({
      kind: "repair",
      message: "The saved mobile connection needs to be repaired before it can be migrated.",
    });
    expect(storage.reads).toEqual([STORAGE_KEY]);
    expect("legacyOrigin" in result).toBe(false);
    expect(JSON.stringify(result)).not.toContain(SECRET);
    expectSafePreparationShape(result);
  });

  it("returns empty after observing all three absent storage generations", () => {
    const { result, storage } = prepareFrom(new Map());

    expect(result).toEqual({ kind: "empty" });
    expect(storage.reads).toEqual([STORAGE_KEY, V2_STORAGE_KEY, LEGACY_STORAGE_KEY]);
    expectSafePreparationShape(result);
  });

  it.each([
    {
      name: "legacy only",
      legacyRaw: JSON.stringify(tailnet("legacy")),
      v2Raw: null,
      expected: {
        version: 3,
        activeHostId: "host_AAAAAAAAAAA",
        hosts: [tailscaleHost("host_AAAAAAAAAAA", "tail_AAAAAAAAAAA", "legacy")],
      },
      legacyOrigin: tailnet("legacy").origin,
    },
    {
      name: "ordered v2 Tailnet directory",
      legacyRaw: null,
      v2Raw: JSON.stringify({
        version: 2,
        activeOrigin: tailnet("second").origin,
        backends: [tailnet("first"), tailnet("second")],
      }),
      expected: {
        version: 3,
        activeHostId: "host_BBBBBBBBBBB",
        hosts: [
          tailscaleHost("host_AAAAAAAAAAA", "tail_AAAAAAAAAAA", "first"),
          tailscaleHost("host_BBBBBBBBBBB", "tail_BBBBBBBBBBB", "second"),
        ],
      },
      legacyOrigin: null,
    },
    {
      name: "duplicate legacy and v2 Tailnet",
      legacyRaw: JSON.stringify(tailnet("first")),
      v2Raw: JSON.stringify({
        version: 2,
        activeOrigin: tailnet("first").origin,
        backends: [tailnet("first")],
      }),
      expected: {
        version: 3,
        activeHostId: "host_AAAAAAAAAAA",
        hosts: [tailscaleHost("host_AAAAAAAAAAA", "tail_AAAAAAAAAAA", "first")],
      },
      legacyOrigin: tailnet("first").origin,
    },
    {
      name: "distinct legacy after v2 Tailnet",
      legacyRaw: JSON.stringify(tailnet("legacy")),
      v2Raw: JSON.stringify({
        version: 2,
        activeOrigin: tailnet("first").origin,
        backends: [tailnet("first")],
      }),
      expected: {
        version: 3,
        activeHostId: "host_AAAAAAAAAAA",
        hosts: [
          tailscaleHost("host_AAAAAAAAAAA", "tail_AAAAAAAAAAA", "first"),
          tailscaleHost("host_BBBBBBBBBBB", "tail_BBBBBBBBBBB", "legacy"),
        ],
      },
      legacyOrigin: tailnet("legacy").origin,
    },
    {
      name: "v2 peer only",
      legacyRaw: null,
      v2Raw: JSON.stringify({ version: 2, kind: "peer", invite: INVITE, label: "T4 private host AAAAAAAA" }),
      expected: {
        version: 3,
        activeHostId: "host_AAAAAAAAAAA",
        hosts: [{
          id: "host_AAAAAAAAAAA",
          label: "T4 private host AAAAAAAA",
          transports: [{
            id: "peer_AAAAAAAAAAA",
            kind: "hyperdht",
            invite: INVITE,
            desktopFingerprint: "AAAAAAAA",
          }],
          preferredTransportIds: ["peer_AAAAAAAAAAA"],
          lastConnection: null,
        }],
      },
      legacyOrigin: null,
    },
    {
      name: "v2 peer plus legacy Tailnet",
      legacyRaw: JSON.stringify(tailnet("legacy")),
      v2Raw: JSON.stringify({ version: 2, kind: "peer", invite: INVITE, label: "T4 private host AAAAAAAA" }),
      expected: {
        version: 3,
        activeHostId: "host_AAAAAAAAAAA",
        hosts: [{
          id: "host_AAAAAAAAAAA",
          label: "T4 private host AAAAAAAA",
          transports: [{
            id: "peer_AAAAAAAAAAA",
            kind: "hyperdht",
            invite: INVITE,
            desktopFingerprint: "AAAAAAAA",
          }],
          preferredTransportIds: ["peer_AAAAAAAAAAA"],
          lastConnection: null,
        }, tailscaleHost("host_BBBBBBBBBBB", "tail_AAAAAAAAAAA", "legacy")],
      },
      legacyOrigin: tailnet("legacy").origin,
    },
  ])("prepares the exact $name candidate without exposing source bytes", ({ legacyRaw, v2Raw, expected, legacyOrigin }) => {
    const values = new Map<string, string>();
    if (v2Raw !== null) values.set(V2_STORAGE_KEY, v2Raw);
    if (legacyRaw !== null) values.set(LEGACY_STORAGE_KEY, legacyRaw);

    const { result, storage } = prepareFrom(values);

    expect(result.kind).toBe("pending");
    if (result.kind !== "pending") throw new Error("expected pending migration");
    expect(result.directory).toEqual(parseMobileHostDirectory(expected));
    if (legacyOrigin === null) {
      expect("legacyOrigin" in result).toBe(false);
    } else {
      expect(result.legacyOrigin).toBe(legacyOrigin);
    }
    expect(storage.reads).toEqual([STORAGE_KEY, V2_STORAGE_KEY, LEGACY_STORAGE_KEY]);
    expectSafePreparationShape(result);
  });

  it.each([STORAGE_KEY, V2_STORAGE_KEY, LEGACY_STORAGE_KEY])(
    "maps a throwing read of %s to controlled repair without mutation",
    (throwingKey) => {
      const { result } = prepareFrom(new Map([
        [V2_STORAGE_KEY, JSON.stringify({ version: 2, kind: "peer", invite: INVITE, label: "T4 private host AAAAAAAA" })],
        [LEGACY_STORAGE_KEY, JSON.stringify(tailnet("legacy"))],
      ]), throwingKey);

      expect(result).toEqual({
        kind: "repair",
        message: "The saved mobile connection needs to be repaired before it can be migrated.",
      });
      expect(JSON.stringify(result)).not.toContain(SECRET);
      expectSafePreparationShape(result);
    },
  );
});
