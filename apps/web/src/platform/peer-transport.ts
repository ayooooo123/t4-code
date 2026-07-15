import {
  decodePeerInvite,
  encodePeerWireFrame,
  PeerWireDecoder,
  type PeerWireFrame,
} from "@t4-code/protocol";
import type { OmpTransport, Unsubscribe } from "@t4-code/client";

import { peerConnection, type T4PeerConnectionPlugin } from "./native-mobile.ts";

const MAX_MESSAGE_BYTES = 4 * 1024 * 1024;
const encoder = new TextEncoder();

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/u, "");
}

function fromBase64Url(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) throw new Error("invalid peer data");
  const padded = value.replace(/-/gu, "+").replace(/_/gu, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(padded);
  const output = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) output[index] = binary.charCodeAt(index);
  return output;
}

function randomNonce(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return base64Url(bytes);
}

async function proof(capability: Uint8Array, nonce: string, challenge: string, desktopPublicKey: Uint8Array): Promise<string> {
  if (crypto.subtle === undefined) throw new Error("browser cryptography unavailable");
  const capabilityCopy = new Uint8Array(capability.byteLength);
  capabilityCopy.set(capability);
  const key = await crypto.subtle.importKey("raw", capabilityCopy, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const prefix = encoder.encode("t4peer/v1\0");
  const nonceBytes = encoder.encode(nonce);
  const challengeBytes = encoder.encode(challenge);
  const payload = new Uint8Array(prefix.byteLength + nonceBytes.byteLength + challengeBytes.byteLength + desktopPublicKey.byteLength);
  payload.set(prefix);
  payload.set(nonceBytes, prefix.byteLength);
  payload.set(challengeBytes, prefix.byteLength + nonceBytes.byteLength);
  payload.set(desktopPublicKey, prefix.byteLength + nonceBytes.byteLength + challengeBytes.byteLength);
  return base64Url(new Uint8Array(await crypto.subtle.sign("HMAC", key, payload)));
}

export class CapacitorPeerTransport implements OmpTransport {
  private readonly invite: string;
  private readonly messages = new Set<(data: string | Uint8Array) => void>();
  private readonly closes = new Set<(code?: number, reason?: string) => void>();
  private readonly errors = new Set<(error: unknown) => void>();
  private readonly decoder = new PeerWireDecoder();
  private plugin: T4PeerConnectionPlugin | undefined;
  private sessionId: string | undefined;
  private removers: (() => Promise<void> | void)[] = [];
  private opened = false;
  private closed = false;

  constructor(invite: string) {
    decodePeerInvite(invite);
    this.invite = invite;
  }

  async open(): Promise<void> {
    if (this.closed) throw new Error("private mobile connection is closed");
    if (this.opened || this.sessionId !== undefined) throw new Error("private mobile connection is already opening");
    const plugin = peerConnection();
    if (plugin === null) throw new Error("native private connection is unavailable");
    const decoded = decodePeerInvite(this.invite);
    this.plugin = plugin;
    const nonce = randomNonce();
    let resolveOpen: (() => void) | undefined;
    let rejectOpen: ((error: Error) => void) | undefined;
    const opening = new Promise<void>((resolve, reject) => { resolveOpen = resolve; rejectOpen = reject; });
    const fail = (error: Error): void => {
      if (this.closed) return;
      rejectOpen?.(error);
      for (const listener of this.errors) listener(error);
      this.close();
    };
    const processFrame = async (frame: PeerWireFrame): Promise<void> => {
      if (frame.type === "challenge") {
        const authorization = await proof(decoded.capability, nonce, frame.nonce, decoded.desktopPublicKey);
        await this.writeFrame({ type: "authorize", proof: authorization });
        return;
      }
      if (frame.type === "authorized") {
        this.opened = true;
        resolveOpen?.();
        return;
      }
      if (frame.type === "message" && this.opened) {
        for (const listener of this.messages) listener(frame.data);
        return;
      }
      fail(new Error("private mobile connection rejected the protocol"));
    };
    const dataListener = await plugin.addListener("peerData", (event) => {
      if (event.sessionId !== this.sessionId || event.data === undefined) return;
      try {
        for (const frame of this.decoder.push(fromBase64Url(event.data))) void processFrame(frame);
      } catch { fail(new Error("private mobile connection received invalid data")); }
    });
    const closeListener = await plugin.addListener("peerClosed", (event) => {
      if (event.sessionId !== this.sessionId) return;
      this.finishClose();
    });
    this.removers = [dataListener.remove, closeListener.remove];
    try {
      const session = await plugin.open({ publicKey: base64Url(decoded.desktopPublicKey) });
      this.sessionId = session.sessionId;
      await this.writeFrame({ type: "hello", version: 1, nonce });
    } catch {
      fail(new Error("could not establish the private mobile connection"));
    }
    const timeout = setTimeout(() => fail(new Error("private mobile connection timed out")), 20_000);
    try { await opening; } finally { clearTimeout(timeout); }
  }

  send(data: string): void {
    if (!this.opened || encoder.encode(data).byteLength > MAX_MESSAGE_BYTES) throw new Error("private mobile connection is not connected");
    void this.writeFrame({ type: "message", data }).catch((error: unknown) => {
      for (const listener of this.errors) listener(error);
      this.close();
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    const plugin = this.plugin;
    const id = this.sessionId;
    this.sessionId = undefined;
    if (plugin !== undefined && id !== undefined) void plugin.close({ sessionId: id }).catch(() => undefined);
    this.finishClose();
  }

  onMessage(listener: (data: string | Uint8Array) => void): Unsubscribe { this.messages.add(listener); return () => this.messages.delete(listener); }
  onClose(listener: (code?: number, reason?: string) => void): Unsubscribe { this.closes.add(listener); return () => this.closes.delete(listener); }
  onError(listener: (error: unknown) => void): Unsubscribe { this.errors.add(listener); return () => this.errors.delete(listener); }

  private async writeFrame(frame: PeerWireFrame): Promise<void> {
    const plugin = this.plugin;
    const sessionId = this.sessionId;
    if (plugin === undefined || sessionId === undefined) throw new Error("private mobile connection is unavailable");
    await plugin.write({ sessionId, data: base64Url(encodePeerWireFrame(frame)) });
  }

  private finishClose(): void {
    for (const remove of this.removers.splice(0)) void remove();
    if (!this.opened && !this.closed) return;
    this.opened = false;
    for (const listener of this.closes) listener(1000, "private connection closed");
    this.messages.clear();
    this.closes.clear();
    this.errors.clear();
  }
}
