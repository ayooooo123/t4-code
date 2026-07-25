const INVITE_PREFIX = "t4peer://v1/";
const KEY_BYTES = 32;
const BASE64URL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

export interface PeerInvite {
  readonly version: 1;
  readonly desktopPublicKey: Uint8Array;
  readonly capability: Uint8Array;
}

export interface PeerInviteMetadata {
  readonly version: 1;
  readonly desktopPublicKey: string;
}

function requiredKey(value: Uint8Array, label: string): Uint8Array {
  if (!(value instanceof Uint8Array) || value.byteLength !== KEY_BYTES) {
    throw new Error(`invalid ${label}`);
  }
  return new Uint8Array(value);
}

function encodeBase64Url(bytes: Uint8Array): string {
  let output = "";
  for (let index = 0; index < bytes.byteLength; index += 3) {
    const a = bytes[index]!;
    const b = bytes[index + 1];
    const c = bytes[index + 2];
    output += BASE64URL[a >>> 2]!;
    output += BASE64URL[((a & 0x03) << 4) | ((b ?? 0) >>> 4)]!;
    if (b !== undefined) output += BASE64URL[((b & 0x0f) << 2) | ((c ?? 0) >>> 6)]!;
    if (c !== undefined) output += BASE64URL[c & 0x3f]!;
  }
  return output;
}

function decodeBase64Url(value: string): Uint8Array {
  if (value.length === 0 || !/^[A-Za-z0-9_-]+$/u.test(value)) throw new Error("invalid peer invite");
  const output: number[] = [];
  let accumulator = 0;
  let bits = 0;
  for (const character of value) {
    const index = BASE64URL.indexOf(character);
    if (index < 0) throw new Error("invalid peer invite");
    accumulator = (accumulator << 6) | index;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      output.push((accumulator >>> bits) & 0xff);
    }
  }
  if (bits > 0 && (accumulator & ((1 << bits) - 1)) !== 0) throw new Error("invalid peer invite");
  const bytes = new Uint8Array(output);
  if (encodeBase64Url(bytes) !== value) throw new Error("invalid peer invite");
  return bytes;
}

export function encodePeerInvite(input: { readonly desktopPublicKey: Uint8Array; readonly capability: Uint8Array }): string {
  const desktopPublicKey = requiredKey(input.desktopPublicKey, "desktop key");
  const capability = requiredKey(input.capability, "peer capability");
  return `${INVITE_PREFIX}${encodeBase64Url(desktopPublicKey)}/${encodeBase64Url(capability)}`;
}

export function decodePeerInvite(value: string): PeerInvite {
  if (typeof value !== "string" || !value.startsWith(INVITE_PREFIX)) throw new Error("invalid peer invite");
  const parts = value.slice(INVITE_PREFIX.length).split("/");
  if (parts.length !== 2) throw new Error("invalid peer invite");
  const desktopPublicKey = decodeBase64Url(parts[0]!);
  const capability = decodeBase64Url(parts[1]!);
  if (desktopPublicKey.byteLength !== KEY_BYTES || capability.byteLength !== KEY_BYTES) throw new Error("invalid peer invite");
  return { version: 1, desktopPublicKey, capability };
}

export function peerInviteMetadata(value: string): PeerInviteMetadata {
  const invite = decodePeerInvite(value);
  return { version: invite.version, desktopPublicKey: encodeBase64Url(invite.desktopPublicKey) };
}
