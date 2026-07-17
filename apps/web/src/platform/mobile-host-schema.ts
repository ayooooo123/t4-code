import {
  parsePeerBackend,
  parseTailnetBackend,
  peerDesktopFingerprint,
  peerDesktopPublicKey,
} from "./mobile-connection-records.ts";

export const MOBILE_HOST_DIRECTORY_STORAGE_KEY = "t4-code:mobile-hosts:v3";

export type MobileTransportKind = "tailscale" | "hyperdht";
export type MobileConnectionOutcome =
  | "connected"
  | "unavailable"
  | "auth"
  | "protocol"
  | "cancelled";

export interface MobileTailscaleTransport {
  readonly id: string;
  readonly kind: "tailscale";
  readonly origin: string;
  readonly wsUrl: string;
  readonly displayAddress: string;
  readonly credentialScopeKey: string;
}

export interface MobileHyperDhtTransport {
  readonly id: string;
  readonly kind: "hyperdht";
  readonly invite: string;
  readonly desktopFingerprint: string;
}

export type MobileHostTransport = MobileTailscaleTransport | MobileHyperDhtTransport;

export interface MobileLastConnection {
  readonly kind: MobileTransportKind;
  readonly at: number;
  readonly outcome: MobileConnectionOutcome;
}

export interface MobileHost {
  readonly id: string;
  readonly label: string;
  readonly transports: readonly MobileHostTransport[];
  readonly preferredTransportIds: readonly string[];
  readonly lastConnection: MobileLastConnection | null;
}

export interface MobileHostDirectory {
  readonly version: 3;
  readonly activeHostId: string;
  readonly hosts: readonly MobileHost[];
}

/** A validation error with copy safe to render at a UI boundary. */
export class StoredMobileDirectoryError extends Error {}

const ID_PATTERN = /^[A-Za-z0-9_-]{16,64}$/u;
const OUTCOMES = new Set<MobileConnectionOutcome>([
  "connected",
  "unavailable",
  "auth",
  "protocol",
  "cancelled",
]);

function invalidDirectory(): never {
  throw new StoredMobileDirectoryError("The saved mobile host directory is invalid.");
}

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) invalidDirectory();
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): void {
  const actual = Object.keys(value);
  if (actual.length !== keys.length || keys.some((key) => !Object.hasOwn(value, key))) {
    invalidDirectory();
  }
}

function id(value: unknown): string {
  if (typeof value !== "string" || !ID_PATTERN.test(value)) invalidDirectory();
  return value;
}

function text(value: unknown): string {
  if (typeof value !== "string") invalidDirectory();
  return value;
}

function containsLabelControl(value: string): boolean {
  return Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f);
  });
}

function parseTransport(value: unknown): MobileHostTransport {
  const input = record(value);
  if (input.kind === "tailscale") {
    exactKeys(input, ["id", "kind", "origin", "wsUrl", "displayAddress", "credentialScopeKey"]);
    const origin = text(input.origin);
    const wsUrl = text(input.wsUrl);
    const displayAddress = text(input.displayAddress);
    const credentialScopeKey = text(input.credentialScopeKey);
    try {
      const canonical = parseTailnetBackend(origin);
      if (
        canonical.origin !== origin ||
        canonical.wsUrl !== wsUrl ||
        canonical.origin !== displayAddress ||
        canonical.origin !== credentialScopeKey
      ) {
        invalidDirectory();
      }
    } catch {
      invalidDirectory();
    }
    return { id: id(input.id), kind: "tailscale", origin, wsUrl, displayAddress, credentialScopeKey };
  }
  if (input.kind === "hyperdht") {
    exactKeys(input, ["id", "kind", "invite", "desktopFingerprint"]);
    const invite = text(input.invite);
    const desktopFingerprint = text(input.desktopFingerprint);
    try {
      const canonical = parsePeerBackend(invite);
      if (
        canonical.invite !== invite ||
        desktopFingerprint !== peerDesktopFingerprint(canonical.invite)
      ) {
        invalidDirectory();
      }
      return {
        id: id(input.id),
        kind: "hyperdht",
        invite,
        desktopFingerprint,
      };
    } catch {
      invalidDirectory();
    }
  }
  invalidDirectory();
}

function parseLastConnection(
  value: unknown,
  transports: readonly MobileHostTransport[],
): MobileLastConnection | null {
  if (value === null) return null;
  const input = record(value);
  exactKeys(input, ["kind", "at", "outcome"]);
  if (
    (input.kind !== "tailscale" && input.kind !== "hyperdht") ||
    !transports.some((transport) => transport.kind === input.kind) ||
    typeof input.at !== "number" ||
    !Number.isSafeInteger(input.at) ||
    input.at < 0 ||
    typeof input.outcome !== "string" ||
    !OUTCOMES.has(input.outcome as MobileConnectionOutcome)
  ) {
    invalidDirectory();
  }
  return {
    kind: input.kind,
    at: input.at,
    outcome: input.outcome as MobileConnectionOutcome,
  };
}

function parseHost(value: unknown): MobileHost {
  const input = record(value);
  exactKeys(input, ["id", "label", "transports", "preferredTransportIds", "lastConnection"]);
  const hostId = id(input.id);
  const label = text(input.label);
  if (
    label.length < 1 ||
    label.length > 128 ||
    label !== label.trim() ||
    containsLabelControl(label)
  ) {
    invalidDirectory();
  }
  if (!Array.isArray(input.transports) || input.transports.length < 1 || input.transports.length > 2) {
    invalidDirectory();
  }
  const transports = input.transports.map(parseTransport);
  if (!Array.isArray(input.preferredTransportIds)) invalidDirectory();
  const preferredTransportIds = input.preferredTransportIds.map(id);
  const transportIds = new Set(transports.map((transport) => transport.id));
  const transportKinds = new Set(transports.map((transport) => transport.kind));
  if (
    transportKinds.size !== transports.length ||
    preferredTransportIds.length !== transports.length ||
    new Set(preferredTransportIds).size !== preferredTransportIds.length ||
    preferredTransportIds.some((transportId) => !transportIds.has(transportId))
  ) {
    invalidDirectory();
  }
  return {
    id: hostId,
    label,
    transports,
    preferredTransportIds,
    lastConnection: parseLastConnection(input.lastConnection, transports),
  };
}

export function parseMobileHostDirectory(value: unknown): MobileHostDirectory {
  const input = record(value);
  exactKeys(input, ["version", "activeHostId", "hosts"]);
  if (input.version !== 3 || !Array.isArray(input.hosts) || input.hosts.length < 1 || input.hosts.length > 16) {
    invalidDirectory();
  }
  const activeHostId = id(input.activeHostId);
  const hosts = input.hosts.map(parseHost);
  if (!hosts.some((host) => host.id === activeHostId)) invalidDirectory();
  const allIds = new Set<string>();
  const canonicalIdentities = new Set<string>();
  for (const host of hosts) {
    if (allIds.has(host.id)) invalidDirectory();
    allIds.add(host.id);
    for (const transport of host.transports) {
      if (allIds.has(transport.id)) invalidDirectory();
      allIds.add(transport.id);
      const identity = canonicalTransportIdentity(transport);
      if (canonicalIdentities.has(identity)) invalidDirectory();
      canonicalIdentities.add(identity);
    }
  }
  return deepFreeze({ version: 3, activeHostId, hosts });
}

export function activeMobileHost(directory: MobileHostDirectory): MobileHost {
  return directory.hosts.find((host) => host.id === directory.activeHostId) ?? invalidDirectory();
}

export function canonicalTransportIdentity(transport: MobileHostTransport): string {
  return transport.kind === "tailscale"
    ? `tailscale:${transport.origin}`
    : `hyperdht:${peerDesktopPublicKey(transport.invite)}`;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
    Object.freeze(value);
  }
  return value;
}
