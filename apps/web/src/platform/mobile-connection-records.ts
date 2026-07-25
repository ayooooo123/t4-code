import { peerInviteMetadata } from "@t4-code/protocol";

export const MAX_MOBILE_CONNECTION_INPUT_BYTES = 2_048;
export const MAX_MOBILE_CONNECTION_LABEL_LENGTH = 128;

export interface StoredMobileBackend {
  readonly version: 1;
  readonly origin: string;
  readonly wsUrl: string;
  readonly label: string;
}

export interface StoredPeerMobileBackend {
  readonly version: 2;
  readonly kind: "peer";
  readonly invite: string;
  readonly label: string;
}

export type StoredMobileConnection = StoredMobileBackend | StoredPeerMobileBackend;

/** Safe validation copy that UI boundaries may render verbatim. */
export class MobileConnectionUserError extends Error {}

function requiredLabel(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_MOBILE_CONNECTION_LABEL_LENGTH
  ) {
    throw new MobileConnectionUserError("The saved host label is invalid.");
  }
  return value;
}

export function parseTailnetBackend(value: string): StoredMobileBackend {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new MobileConnectionUserError("Enter the HTTPS address shown by T4 Code on your computer.");
  }
  if (trimmed.length > MAX_MOBILE_CONNECTION_INPUT_BYTES) {
    throw new MobileConnectionUserError("That address is too long.");
  }

  const candidate = trimmed.includes("://") ? trimmed : `https://${trimmed}`;
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new MobileConnectionUserError("Enter a valid HTTPS Tailnet address.");
  }
  if (parsed.protocol !== "https:") {
    throw new MobileConnectionUserError("Use the HTTPS Tailnet address, not HTTP.");
  }
  if (parsed.username !== "" || parsed.password !== "") {
    throw new MobileConnectionUserError("The address cannot contain credentials.");
  }
  if (parsed.pathname !== "/" || parsed.search !== "" || parsed.hash !== "") {
    throw new MobileConnectionUserError("Enter the host address only, without a path, query, or fragment.");
  }
  const hostname = parsed.hostname.toLowerCase();
  if (
    hostname === "ts.net" ||
    !hostname.endsWith(".ts.net") ||
    hostname.split(".").some((label) => label.length === 0)
  ) {
    throw new MobileConnectionUserError("Use the full Tailscale hostname ending in .ts.net.");
  }

  const origin = parsed.origin;
  const websocket = new URL(origin);
  websocket.protocol = "wss:";
  websocket.pathname = "/v1/ws";
  const deviceName = hostname.slice(0, hostname.indexOf("."));
  return {
    version: 1,
    origin,
    wsUrl: websocket.toString(),
    label: requiredLabel(`T4 on ${deviceName}`),
  };
}

function validPeerDesktopPublicKey(invite: string): string {
  try {
    return peerInviteMetadata(invite).desktopPublicKey;
  } catch {
    throw new MobileConnectionUserError("Enter a valid T4 private connection key.");
  }
}

export function peerDesktopPublicKey(invite: string): string {
  return validPeerDesktopPublicKey(invite);
}

export function peerDesktopFingerprint(invite: string): string {
  return peerDesktopPublicKey(invite).slice(0, 8);
}

export function parsePeerBackend(value: string): StoredPeerMobileBackend {
  if (
    value.length === 0 ||
    new TextEncoder().encode(value).byteLength > MAX_MOBILE_CONNECTION_INPUT_BYTES
  ) {
    throw new MobileConnectionUserError("Enter a private connection key.");
  }
  const invite = value.trim();
  if (invite.length === 0) {
    throw new MobileConnectionUserError("Enter a private connection key.");
  }
  const desktopPublicKey = validPeerDesktopPublicKey(invite);
  return {
    version: 2,
    kind: "peer",
    invite,
    label: requiredLabel(`T4 private host ${desktopPublicKey.slice(0, 8)}`),
  };
}
