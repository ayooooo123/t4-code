import { createHmac, randomBytes as nodeRandomBytes, timingSafeEqual } from "node:crypto";
import DHT from "hyperdht";
import { encodePeerInvite, encodePeerWireFrame, PeerWireDecoder, peerInviteMetadata, type PeerWireFrame } from "@t4-code/protocol";
import type { OmpTransport } from "@t4-code/client";
import { createLocalTransport } from "./transport.ts";

const SHARE_DURATION_MS = 15 * 60 * 1_000;
const KEY_BYTES = 32;
const MAX_ACTIVE_STREAMS = 4;

export interface PeerKeyPair {
  readonly publicKey: Uint8Array;
  readonly secretKey: Uint8Array;
}

export interface PeerPairingMaterial extends PeerKeyPair {
  readonly capability: Uint8Array;
}

export interface PeerPairingStore {
  load(): Promise<PeerPairingMaterial | null>;
  save(value: PeerPairingMaterial): Promise<void>;
}

export interface PeerServer {
  listen(keyPair: PeerKeyPair): Promise<void>;
  close(): Promise<void>;
  on(event: "connection", listener: (stream: PeerStream) => void): void;
}

export interface PeerStream {
  on(event: "data", listener: (value: Uint8Array) => void): void;
  on(event: "close", listener: () => void): void;
  write(value: Uint8Array): void;
  destroy?(): void;
}

export interface PeerDht {
  createServer(): PeerServer;
  destroy(): Promise<void>;
}

export type PeerShareStatus =
  | { readonly state: "stopped" }
  | { readonly state: "sharing"; readonly desktopPublicKey: string };

export interface PeerShareHostOptions {
  readonly createDht?: () => PeerDht;
  readonly createKeyPair?: () => PeerKeyPair;
  readonly randomBytes?: (length: number) => Uint8Array;
  readonly now?: () => number;
  readonly setTimer?: (callback: () => void, delay: number) => unknown;
  readonly clearTimer?: (timer: unknown) => void;
  readonly createAppserverTransport?: () => Promise<OmpTransport>;
  readonly pairingStore?: PeerPairingStore;
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

async function defaultAppserverTransport(): Promise<OmpTransport> {
  const transport = createLocalTransport();
  await transport.open();
  return transport;
}

function requireLength(value: Uint8Array, name: string, expected: number): Uint8Array {
  if (!(value instanceof Uint8Array) || value.byteLength !== expected) throw new Error(`invalid ${name}`);
  return value;
}

function authorizationProof(capability: Uint8Array, clientNonce: string, challenge: string, desktopPublicKey: Uint8Array): string {
  return createHmac("sha256", capability)
    .update("t4peer/v1\0")
    .update(clientNonce)
    .update(challenge)
    .update(desktopPublicKey)
    .digest("base64url");
}

function sameProof(expected: string, provided: string): boolean {
  const expectedBytes = Buffer.from(expected, "utf8");
  const providedBytes = Buffer.from(provided, "utf8");
  return expectedBytes.byteLength === providedBytes.byteLength && timingSafeEqual(expectedBytes, providedBytes);
}

export class PeerShareHost {
  private readonly createDht: () => PeerDht;
  private readonly createKeyPair: () => PeerKeyPair;
  private readonly randomBytes: (length: number) => Uint8Array;
  private readonly now: () => number;
  private readonly setTimer: (callback: () => void, delay: number) => unknown;
  private readonly clearTimer: (timer: unknown) => void;
  private readonly createAppserverTransport: () => Promise<OmpTransport>;
  private readonly pairingStore: PeerPairingStore | undefined;
  private readonly activeTransports = new Set<OmpTransport>();
  private readonly activeStreams = new Set<PeerStream>();
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
    this.createAppserverTransport = options.createAppserverTransport ?? defaultAppserverTransport;
    this.pairingStore = options.pairingStore;
  }

  async start(): Promise<{ readonly invite: string }> {
    if (this.live !== undefined) return { invite: this.live.invite };
    await this.stop();
    const saved = await this.pairingStore?.load();
    const keyPair = saved ?? this.createKeyPair();
    const desktopPublicKey = requireLength(keyPair.publicKey, "desktop peer key", KEY_BYTES);
    requireLength(keyPair.secretKey, "desktop peer secret", 64);
    const capability = requireLength(saved?.capability ?? this.randomBytes(KEY_BYTES), "peer capability", KEY_BYTES);
    if (saved === null) await this.pairingStore?.save({ publicKey: desktopPublicKey, secretKey: keyPair.secretKey, capability });
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
    if (this.pairingStore === undefined) this.timer = this.setTimer(() => { void this.stop(); }, SHARE_DURATION_MS);
    return { invite: this.live.invite };
  }

  async regenerate(): Promise<{ readonly invite: string }> {
    const saved = await this.pairingStore?.load();
    if (saved === undefined) {
      await this.stop();
      return this.start();
    }
    const capability = requireLength(this.randomBytes(KEY_BYTES), "peer capability", KEY_BYTES);
    const keyPair = saved ?? this.createKeyPair();
    const publicKey = requireLength(keyPair.publicKey, "desktop peer key", KEY_BYTES);
    const secretKey = requireLength(keyPair.secretKey, "desktop peer secret", 64);
    await this.pairingStore?.save({ publicKey, secretKey, capability });
    await this.stop();
    return this.start();
  }

  status(): PeerShareStatus {
    if (this.live === undefined) return { state: "stopped" };
    const metadata = peerInviteMetadata(this.live.invite);
    return { state: "sharing", desktopPublicKey: metadata.desktopPublicKey };
  }

  async stop(): Promise<void> {
    const dht = this.dht;
    const server = this.server;
    const timer = this.timer;
    this.dht = undefined;
    this.server = undefined;
    this.timer = undefined;
    this.live = undefined;
    const activeStreams = [...this.activeStreams];
    this.activeStreams.clear();
    if (timer !== undefined) this.clearTimer(timer);
    for (const transport of this.activeTransports) transport.close();
    this.activeTransports.clear();
    for (const stream of activeStreams) stream.destroy?.();
    if (server !== undefined) await server.close().catch(() => undefined);
    if (dht !== undefined) await dht.destroy().catch(() => undefined);
  }

  private onConnection(stream: PeerStream): void {
    const decoder = new PeerWireDecoder();
    let phase: "hello" | "challenge" | "opening" | "authorized" = "hello";
    let clientNonce: string | undefined;
    let challenge: string | undefined;
    let upstream: OmpTransport | undefined;
    let queue = Promise.resolve();
    const release = () => { this.activeStreams.delete(stream); };
    const closeUpstream = () => {
      if (upstream === undefined) return;
      const transport = upstream;
      upstream = undefined;
      this.activeTransports.delete(transport);
      transport.close();
    };
    const terminate = () => {
      release();
      closeUpstream();
      stream.destroy?.();
    };
    stream.on("close", () => {
      release();
      closeUpstream();
    });
    stream.on("data", (chunk) => {
      queue = queue.then(async () => {
        const frames = decoder.push(chunk);
        for (const frame of frames) {
          if (this.live === undefined) {
            terminate();
            return;
          }
          if (phase === "hello" && frame.type === "hello") {
            clientNonce = frame.nonce;
            challenge = Buffer.from(requireLength(this.randomBytes(KEY_BYTES), "peer challenge", KEY_BYTES)).toString("base64url");
            stream.write(encodePeerWireFrame({ type: "challenge", nonce: challenge }));
            phase = "challenge";
            continue;
          }
          if (phase === "challenge" && frame.type === "authorize" && clientNonce !== undefined && challenge !== undefined) {
            const expected = authorizationProof(
              this.live.capability,
              clientNonce,
              challenge,
              this.live.desktopPublicKey,
            );
            if (!sameProof(expected, frame.proof)) {
              terminate();
              return;
            }
            if (this.activeStreams.size >= MAX_ACTIVE_STREAMS) {
              terminate();
              return;
            }
            this.activeStreams.add(stream);
            phase = "opening";
            const transport = await this.createAppserverTransport();
            if (this.live === undefined || phase !== "opening" || !this.activeStreams.has(stream)) {
              transport.close();
              release();
              return;
            }
            upstream = transport;
            this.activeTransports.add(transport);
            transport.onMessage((data) => {
              if (phase !== "authorized" || typeof data !== "string") {
                terminate();
                return;
              }
              stream.write(encodePeerWireFrame({ type: "message", data }));
            });
            transport.onClose(() => terminate());
            transport.onError(() => terminate());
            stream.write(encodePeerWireFrame({ type: "authorized" }));
            phase = "authorized";
            continue;
          }
          if (phase === "authorized" && frame.type === "message" && upstream !== undefined) {
            upstream.send(frame.data);
            continue;
          }
          terminate();
          return;
        }
      }).catch(() => terminate());
    });
  }
}
