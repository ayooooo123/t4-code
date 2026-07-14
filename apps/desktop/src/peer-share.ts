import { randomBytes as nodeRandomBytes } from "node:crypto";
import DHT from "hyperdht";
import { encodePeerInvite, encodePeerWireFrame, PeerWireDecoder, peerInviteMetadata, type PeerWireFrame } from "@t4-code/protocol";

const SHARE_DURATION_MS = 15 * 60 * 1_000;
const KEY_BYTES = 32;

export interface PeerKeyPair {
  readonly publicKey: Uint8Array;
  readonly secretKey: Uint8Array;
}

export interface PeerServer {
  listen(keyPair: PeerKeyPair): Promise<void>;
  close(): Promise<void>;
  on(event: "connection", listener: (stream: PeerStream) => void): void;
}

export interface PeerStream {
  on(event: "data", listener: (value: Uint8Array) => void): void;
  write(value: Uint8Array): void;
  destroy?(): void;
}

export interface PeerDht {
  createServer(): PeerServer;
  destroy(): Promise<void>;
}

export type PeerShareStatus =
  | { readonly state: "stopped" }
  | { readonly state: "sharing"; readonly expiresAt: number; readonly desktopPublicKey: string };

export interface PeerShareHostOptions {
  readonly createDht?: () => PeerDht;
  readonly createKeyPair?: () => PeerKeyPair;
  readonly randomBytes?: (length: number) => Uint8Array;
  readonly now?: () => number;
  readonly setTimer?: (callback: () => void, delay: number) => unknown;
  readonly clearTimer?: (timer: unknown) => void;
}

function defaultDht(): PeerDht {
  return new DHT() as unknown as PeerDht;
}

function defaultKeyPair(): PeerKeyPair {
  return DHT.keyPair() as unknown as PeerKeyPair;
}

function random(length: number): Uint8Array {
  return new Uint8Array(nodeRandomBytes(length));
}

function requireLength(value: Uint8Array, name: string, expected: number): Uint8Array {
  if (!(value instanceof Uint8Array) || value.byteLength !== expected) throw new Error(`invalid ${name}`);
  return value;
}

export class PeerShareHost {
  private readonly createDht: () => PeerDht;
  private readonly createKeyPair: () => PeerKeyPair;
  private readonly randomBytes: (length: number) => Uint8Array;
  private readonly now: () => number;
  private readonly setTimer: (callback: () => void, delay: number) => unknown;
  private readonly clearTimer: (timer: unknown) => void;
  private dht: PeerDht | undefined;
  private server: PeerServer | undefined;
  private timer: unknown;
  private live: {
    readonly invite: string;
    readonly expiresAt: number;
    readonly desktopPublicKey: Uint8Array;
    readonly capability: Uint8Array;
  } | undefined;

  constructor(options: PeerShareHostOptions = {}) {
    this.createDht = options.createDht ?? defaultDht;
    this.createKeyPair = options.createKeyPair ?? defaultKeyPair;
    this.randomBytes = options.randomBytes ?? random;
    this.now = options.now ?? Date.now;
    this.setTimer = options.setTimer ?? ((callback, delay) => setTimeout(callback, delay));
    this.clearTimer = options.clearTimer ?? ((timer) => clearTimeout(timer as NodeJS.Timeout));
  }

  async start(): Promise<{ readonly invite: string; readonly expiresAt: number }> {
    await this.stop();
    const keyPair = this.createKeyPair();
    const desktopPublicKey = requireLength(keyPair.publicKey, "desktop peer key", KEY_BYTES);
    requireLength(keyPair.secretKey, "desktop peer secret", 64);
    const capability = requireLength(this.randomBytes(KEY_BYTES), "peer capability", KEY_BYTES);
    const dht = this.createDht();
    const server = dht.createServer();
    server.on("connection", (stream) => this.onConnection(stream));
    try {
      await server.listen(keyPair);
    } catch (error) {
      await dht.destroy().catch(() => undefined);
      throw error;
    }
    const invite = encodePeerInvite({ desktopPublicKey, capability });
    const expiresAt = this.now() + SHARE_DURATION_MS;
    this.dht = dht;
    this.server = server;
    this.live = { invite, expiresAt, desktopPublicKey, capability };
    this.timer = this.setTimer(() => { void this.stop(); }, SHARE_DURATION_MS);
    return this.live;
  }

  status(): PeerShareStatus {
    if (this.live === undefined) return { state: "stopped" };
    const metadata = peerInviteMetadata(this.live.invite);
    return { state: "sharing", expiresAt: this.live.expiresAt, desktopPublicKey: metadata.desktopPublicKey };
  }

  async stop(): Promise<void> {
    const dht = this.dht;
    const server = this.server;
    const timer = this.timer;
    this.dht = undefined;
    this.server = undefined;
    this.timer = undefined;
    this.live = undefined;
    if (timer !== undefined) this.clearTimer(timer);
    if (server !== undefined) await server.close().catch(() => undefined);
    if (dht !== undefined) await dht.destroy().catch(() => undefined);
  }

  private onConnection(stream: PeerStream): void {
    const decoder = new PeerWireDecoder();
    let phase: "hello" | "challenge" = "hello";
    stream.on("data", (chunk) => {
      let frames: PeerWireFrame[];
      try {
        frames = decoder.push(chunk);
      } catch {
        stream.destroy?.();
        return;
      }
      for (const frame of frames) {
        if (phase !== "hello" || frame.type !== "hello" || this.live === undefined) {
          stream.destroy?.();
          return;
        }
        const challenge = Buffer.from(this.randomBytes(KEY_BYTES)).toString("base64url");
        stream.write(encodePeerWireFrame({ type: "challenge", nonce: challenge }));
        phase = "challenge";
      }
    });
  }
}
