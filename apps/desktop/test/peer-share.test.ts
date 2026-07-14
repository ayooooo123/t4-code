import { describe, expect, it } from "vite-plus/test";
import { encodePeerWireFrame, PeerWireDecoder } from "@t4-code/protocol";
import * as peer from "../src/peer-share.ts";

class FakeServer {
  listens = 0;
  closes = 0;
  connection: ((socket: FakePeerSocket) => void) | undefined;
  async listen(): Promise<void> { this.listens += 1; }
  async close(): Promise<void> { this.closes += 1; }
  on(event: "connection", listener: (socket: FakePeerSocket) => void): void {
    if (event === "connection") this.connection = listener;
  }
}

class FakePeerSocket {
  readonly writes: Uint8Array[] = [];
  private dataListener: ((value: Uint8Array) => void) | undefined;
  on(event: "data", listener: (value: Uint8Array) => void): void {
    if (event === "data") this.dataListener = listener;
  }
  write(value: Uint8Array): void { this.writes.push(value); }
  send(value: Uint8Array): void { this.dataListener?.(value); }
}

class FakeDht {
  readonly server = new FakeServer();
  destroys = 0;
  createServer(): FakeServer { return this.server; }
  async destroy(): Promise<void> { this.destroys += 1; }
}

describe("PeerShareHost", () => {
  it("creates an ephemeral invite while keeping its capability out of status", async () => {
    const PeerShareHost = (peer as Record<string, unknown>).PeerShareHost as new (options: {
      readonly createDht: () => FakeDht;
      readonly createKeyPair: () => { readonly publicKey: Uint8Array; readonly secretKey: Uint8Array };
      readonly randomBytes: (length: number) => Uint8Array;
      readonly now: () => number;
      readonly setTimer: (callback: () => void, delay: number) => unknown;
      readonly clearTimer: (timer: unknown) => void;
    }) => {
      start(): Promise<{ readonly invite: string; readonly expiresAt: number }>;
      status(): unknown;
      stop(): Promise<void>;
    };
    const dht = new FakeDht();
    const host = new PeerShareHost({
      createDht: () => dht,
      createKeyPair: () => ({ publicKey: new Uint8Array(32).fill(3), secretKey: new Uint8Array(64).fill(4) }),
      randomBytes: (length) => new Uint8Array(length).fill(9),
      now: () => 100,
      setTimer: () => 1,
      clearTimer: () => undefined,
    });

    const share = await host.start();

    expect(share.invite).toMatch(/^t4peer:\/\/v1\//u);
    expect(share.expiresAt).toBe(900_100);
    expect(JSON.stringify(host.status())).not.toContain(share.invite.split("/").at(-1)!);
    await host.stop();
    expect(dht.server.closes).toBe(1);
    expect(dht.destroys).toBe(1);
  });

  it("challenges an incoming stream only after a peer hello", async () => {
    const PeerShareHost = (peer as Record<string, unknown>).PeerShareHost as new (options: {
      readonly createDht: () => FakeDht;
      readonly createKeyPair: () => { readonly publicKey: Uint8Array; readonly secretKey: Uint8Array };
      readonly randomBytes: (length: number) => Uint8Array;
      readonly setTimer: (callback: () => void, delay: number) => unknown;
      readonly clearTimer: (timer: unknown) => void;
    }) => { start(): Promise<unknown>; stop(): Promise<void> };
    const dht = new FakeDht();
    let randomCall = 0;
    const host = new PeerShareHost({
      createDht: () => dht,
      createKeyPair: () => ({ publicKey: new Uint8Array(32).fill(3), secretKey: new Uint8Array(64).fill(4) }),
      randomBytes: (length) => new Uint8Array(length).fill(++randomCall),
      setTimer: () => 1,
      clearTimer: () => undefined,
    });
    await host.start();
    const socket = new FakePeerSocket();

    dht.server.connection?.(socket);
    expect(socket.writes).toEqual([]);
    socket.send(encodePeerWireFrame({ type: "hello", version: 1, nonce: "client-nonce" }));

    const frames = new PeerWireDecoder().push(socket.writes[0]!);
    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({ type: "challenge" });
    expect(frames[0]?.type === "challenge" && frames[0].nonce.length > 0).toBe(true);
    await host.stop();
  });
});
