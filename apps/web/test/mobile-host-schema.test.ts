import { describe, expect, it } from "vite-plus/test";

import {
  StoredMobileDirectoryError,
  activeMobileHost,
  canonicalTransportIdentity,
  parseMobileHostDirectory,
} from "../src/platform/mobile-host-schema.ts";

const PUBLIC_KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const CAPABILITY = "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBA";
const INVITE = `t4peer://v1/${PUBLIC_KEY}/${CAPABILITY}`;

const HOST_A = "host_AAAAAAAAAAA";
const HOST_B = "host_BBBBBBBBBBB";
const TAILSCALE_A = "tail_AAAAAAAAAAA";
const TAILSCALE_B = "tail_BBBBBBBBBBB";
const HYPERDHT_A = "peer_AAAAAAAAAAA";

function tailscale(id = TAILSCALE_A, name = "desk") {
  const origin = `https://${name}.tailnet.ts.net:8445`;
  return {
    id,
    kind: "tailscale",
    origin,
    wsUrl: `wss://${name}.tailnet.ts.net:8445/v1/ws`,
    displayAddress: origin,
    credentialScopeKey: origin,
  };
}

function hyperdht(id = HYPERDHT_A, invite = INVITE) {
  return { id, kind: "hyperdht", invite, desktopFingerprint: "AAAAAAAA" };
}

function host(overrides: Record<string, unknown> = {}) {
  return {
    id: HOST_A,
    label: "Desk",
    transports: [tailscale()],
    preferredTransportIds: [TAILSCALE_A],
    lastConnection: null,
    ...overrides,
  };
}

function directory(overrides: Record<string, unknown> = {}) {
  return { version: 3, activeHostId: HOST_A, hosts: [host()], ...overrides };
}

function expectControlledError(value: unknown, secret = "private-secret"): void {
  let error: unknown;
  try {
    parseMobileHostDirectory(value);
  } catch (caught) {
    error = caught;
  }
  expect(error).toBeInstanceOf(StoredMobileDirectoryError);
  expect(error instanceof Error ? error.message : String(error)).not.toContain(secret);
}

describe("mobile host directory v3 structure", () => {
  it.each([
    ["null", null],
    ["array", []],
    ["wrong version", directory({ version: 2 })],
  ])("rejects %s at the top level", (_name, value) => {
    expect(() => parseMobileHostDirectory(value)).toThrow(StoredMobileDirectoryError);
  });

  it.each([
    ["top level", directory({ privateSecret: "private-secret" })],
    ["host", directory({ hosts: [host({ privateSecret: "private-secret" })] })],
    ["Tailscale transport", directory({ hosts: [host({ transports: [{ ...tailscale(), privateSecret: "private-secret" }] })] })],
    ["HyperDHT transport", directory({ hosts: [host({ transports: [{ ...hyperdht(), privateSecret: "private-secret" }], preferredTransportIds: [HYPERDHT_A] })] })],
    ["last connection", directory({ hosts: [host({ lastConnection: { kind: "tailscale", at: 0, outcome: "connected", privateSecret: "private-secret" } })] })],
  ])("rejects an extra key on the %s object without exposing it", (_name, value) => {
    expectControlledError(value);
  });

  it("requires between one and sixteen hosts", () => {
    expect(() => parseMobileHostDirectory(directory({ hosts: [] }))).toThrow(StoredMobileDirectoryError);
    expect(() => parseMobileHostDirectory(directory({
      hosts: Array.from({ length: 17 }, (_, index) => {
        const suffix = String(index).padStart(11, "0");
        const transportId = `tail_${suffix}`;
        return host({
          id: `host_${suffix}`,
          transports: [tailscale(transportId, `desk${index}`)],
          preferredTransportIds: [transportId],
        });
      }),
    }))).toThrow(StoredMobileDirectoryError);
  });

  it("requires the active host to exist", () => {
    expect(() => parseMobileHostDirectory(directory({ activeHostId: HOST_B }))).toThrow(StoredMobileDirectoryError);
  });

  it.each(["short", "has spaces_______", "unicode_é________"])("rejects invalid ID %s", (id) => {
    expect(() => parseMobileHostDirectory(directory({ activeHostId: id, hosts: [host({ id })] }))).toThrow(StoredMobileDirectoryError);
  });

  it.each([
    ["empty", ""],
    ["leading whitespace", " Desk"],
    ["trailing whitespace", "Desk "],
    ["control character", "Desk\nprivate-secret"],
    ["too long", "x".repeat(129)],
  ])("rejects a host label that is %s", (_name, label) => {
    expectControlledError(directory({ hosts: [host({ label })] }));
  });

  it("requires one or two transports per host", () => {
    expect(() => parseMobileHostDirectory(directory({ hosts: [host({ transports: [], preferredTransportIds: [] })] }))).toThrow(StoredMobileDirectoryError);
    expect(() => parseMobileHostDirectory(directory({ hosts: [host({ transports: [tailscale(), hyperdht(), hyperdht("peer_BBBBBBBBBBB")], preferredTransportIds: [TAILSCALE_A, HYPERDHT_A, "peer_BBBBBBBBBBB"] })] }))).toThrow(StoredMobileDirectoryError);
  });

  it.each([
    ["negative timestamp", { kind: "tailscale", at: -1, outcome: "connected" }],
    ["fractional timestamp", { kind: "tailscale", at: 1.5, outcome: "connected" }],
    ["unsafe timestamp", { kind: "tailscale", at: Number.MAX_SAFE_INTEGER + 1, outcome: "connected" }],
    ["unknown kind", { kind: "iroh", at: 0, outcome: "connected" }],
    ["kind missing on host", { kind: "hyperdht", at: 0, outcome: "connected" }],
    ["unknown outcome", { kind: "tailscale", at: 0, outcome: "private-secret" }],
  ])("rejects last-connection data with %s", (_name, lastConnection) => {
    expectControlledError(directory({ hosts: [host({ lastConnection })] }));
  });

  it("returns the active host", () => {
    const parsed = parseMobileHostDirectory(directory());
    expect(activeMobileHost(parsed).id).toBe(HOST_A);
  });
});

describe("mobile host directory v3 identifiers and preferences", () => {
  function twoHosts(secondOverrides: Record<string, unknown> = {}) {
    return directory({
      hosts: [
        host(),
        host({
          id: HOST_B,
          label: "Laptop",
          transports: [tailscale(TAILSCALE_B, "laptop")],
          preferredTransportIds: [TAILSCALE_B],
          ...secondOverrides,
        }),
      ],
    });
  }

  it("rejects duplicate host IDs", () => {
    expect(() => parseMobileHostDirectory(twoHosts({ id: HOST_A }))).toThrow(StoredMobileDirectoryError);
  });

  it("rejects duplicate transport IDs across hosts", () => {
    expect(() => parseMobileHostDirectory(twoHosts({
      transports: [tailscale(TAILSCALE_A, "laptop")],
      preferredTransportIds: [TAILSCALE_A],
    }))).toThrow(StoredMobileDirectoryError);
  });

  it("rejects a host ID that collides with a transport ID", () => {
    expect(() => parseMobileHostDirectory(twoHosts({
      transports: [tailscale(HOST_A, "laptop")],
      preferredTransportIds: [HOST_A],
    }))).toThrow(StoredMobileDirectoryError);
  });

  it("rejects duplicate preferred transport IDs", () => {
    expect(() => parseMobileHostDirectory(directory({ hosts: [host({
      transports: [tailscale(), hyperdht()],
      preferredTransportIds: [TAILSCALE_A, TAILSCALE_A],
    })] }))).toThrow(StoredMobileDirectoryError);
  });

  it("rejects a missing preferred transport ID", () => {
    expect(() => parseMobileHostDirectory(directory({ hosts: [host({
      transports: [tailscale(), hyperdht()],
      preferredTransportIds: [TAILSCALE_A],
    })] }))).toThrow(StoredMobileDirectoryError);
  });

  it("rejects a foreign preferred transport ID", () => {
    expect(() => parseMobileHostDirectory(directory({ hosts: [host({
      preferredTransportIds: [TAILSCALE_B],
    })] }))).toThrow(StoredMobileDirectoryError);
  });

  it("rejects duplicate transport kinds within one host", () => {
    expect(() => parseMobileHostDirectory(directory({ hosts: [host({
      transports: [tailscale(), tailscale(TAILSCALE_B, "laptop")],
      preferredTransportIds: [TAILSCALE_A, TAILSCALE_B],
    })] }))).toThrow(StoredMobileDirectoryError);
  });
});

describe("mobile host directory v3 canonical transports", () => {
  it.each([
    ["origin", { origin: "https://DESK.tailnet.ts.net:8445" }],
    ["WebSocket URL", { wsUrl: "wss://other.tailnet.ts.net:8445/v1/ws" }],
    ["display address", { displayAddress: "desk.tailnet.ts.net:8445" }],
    ["credential scope", { credentialScopeKey: "https://other.tailnet.ts.net:8445" }],
  ])("rejects a noncanonical Tailnet %s", (_name, override) => {
    expect(() => parseMobileHostDirectory(directory({ hosts: [host({
      transports: [{ ...tailscale(), ...override }],
    })] }))).toThrow(StoredMobileDirectoryError);
  });

  it("rejects an invalid HyperDHT invite without exposing it", () => {
    expectControlledError(directory({ hosts: [host({
      transports: [hyperdht(HYPERDHT_A, "private-secret")],
      preferredTransportIds: [HYPERDHT_A],
    })] }));
  });

  it("rejects a whitespace-wrapped HyperDHT invite instead of rewriting stored bytes", () => {
    expect(() => parseMobileHostDirectory(directory({ hosts: [host({
      transports: [hyperdht(HYPERDHT_A, ` ${INVITE} `)],
      preferredTransportIds: [HYPERDHT_A],
    })] }))).toThrow(StoredMobileDirectoryError);
  });

  it("rejects a forged HyperDHT desktop fingerprint", () => {
    expect(() => parseMobileHostDirectory(directory({ hosts: [host({
      transports: [{ ...hyperdht(), desktopFingerprint: "BBBBBBBB" }],
      preferredTransportIds: [HYPERDHT_A],
    })] }))).toThrow(StoredMobileDirectoryError);
  });

  it("rejects duplicate canonical Tailnet origins across hosts", () => {
    expect(() => parseMobileHostDirectory(directory({ hosts: [
      host(),
      host({
        id: HOST_B,
        label: "Same route",
        transports: [tailscale(TAILSCALE_B)],
        preferredTransportIds: [TAILSCALE_B],
      }),
    ] }))).toThrow(StoredMobileDirectoryError);
  });

  it("rejects one HyperDHT public key with different capabilities across hosts", () => {
    const otherInvite = `t4peer://v1/${PUBLIC_KEY}/${"C".repeat(42)}A`;
    expect(() => parseMobileHostDirectory(directory({ hosts: [
      host({ transports: [hyperdht()], preferredTransportIds: [HYPERDHT_A] }),
      host({
        id: HOST_B,
        label: "Same peer",
        transports: [hyperdht("peer_BBBBBBBBBBB", otherInvite)],
        preferredTransportIds: ["peer_BBBBBBBBBBB"],
      }),
    ] }))).toThrow(StoredMobileDirectoryError);
  });

  it("returns exact canonical transport identity strings", () => {
    const parsed = parseMobileHostDirectory(directory({ hosts: [host({
      transports: [tailscale(), hyperdht()],
      preferredTransportIds: [TAILSCALE_A, HYPERDHT_A],
    })] }));
    expect(canonicalTransportIdentity(parsed.hosts[0]!.transports[0]!)).toBe(
      "tailscale:https://desk.tailnet.ts.net:8445",
    );
    expect(canonicalTransportIdentity(parsed.hosts[0]!.transports[1]!)).toBe(
      `hyperdht:${PUBLIC_KEY}`,
    );
  });

  it("recursively freezes every parsed object and array", () => {
    const parsed = parseMobileHostDirectory(directory({ hosts: [host({
      transports: [tailscale(), hyperdht()],
      preferredTransportIds: [TAILSCALE_A, HYPERDHT_A],
      lastConnection: { kind: "hyperdht", at: 42, outcome: "connected" },
    })] }));
    const active = parsed.hosts[0]!;
    expect([
      parsed,
      parsed.hosts,
      active,
      active.transports,
      active.transports[0],
      active.transports[1],
      active.preferredTransportIds,
      active.lastConnection,
    ].every(Object.isFrozen)).toBe(true);
  });
});
