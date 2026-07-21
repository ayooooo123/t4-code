import { describe, expect, it } from "vite-plus/test";
import { createHmac } from "node:crypto";
import { encodePeerWireFrame, PeerWireDecoder } from "@t4-code/protocol";
import type { OmpTransport, Unsubscribe } from "@t4-code/client";
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
  destroyed = false;
  private dataListener: ((value: Uint8Array) => void) | undefined;
  private closeListener: (() => void) | undefined;
  on(event: "data" | "close", listener: ((value: Uint8Array) => void) | (() => void)): void {
    if (event === "data") this.dataListener = listener;
    if (event === "close") this.closeListener = listener as () => void;
  }
  write(value: Uint8Array): void { this.writes.push(value); }
  send(value: Uint8Array): void { this.dataListener?.(value); }
  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.closeListener?.();
  }
}

class FakeOmpTransport implements OmpTransport {
  readonly sent: string[] = [];
  private readonly messages = new Set<(data: string | Uint8Array) => void>();
  private readonly closes = new Set<(code?: number, reason?: string) => void>();
  private readonly errors = new Set<(error: unknown) => void>();
  send(data: string): void { this.sent.push(data); }
  close(): void { for (const listener of this.closes) listener(1000, "closed"); }
  onMessage(listener: (data: string | Uint8Array) => void): Unsubscribe { this.messages.add(listener); return () => this.messages.delete(listener); }
  onClose(listener: (code?: number, reason?: string) => void): Unsubscribe { this.closes.add(listener); return () => this.closes.delete(listener); }
  onError(listener: (error: unknown) => void): Unsubscribe { this.errors.add(listener); return () => this.errors.delete(listener); }
  emitMessage(data: string): void { for (const listener of this.messages) listener(data); }
}

async function waitFor(condition: () => boolean, description: string): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${description}`);
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
}

async function waitForWrites(socket: FakePeerSocket, count: number): Promise<void> {
  await waitFor(() => socket.writes.length >= count, `${count} peer writes`);
}

class FakeDht {
  readonly server = new FakeServer();
  destroys = 0;
  createServer(): FakeServer { return this.server; }
  async destroy(): Promise<void> { this.destroys += 1; }
}

describe("PeerShareHost", () => {
  it("shares one listener while concurrent callers start the host", async () => {
    const dht = new FakeDht();
    let resolveListen: (() => void) | undefined;
    const listening = new Promise<void>((resolve) => { resolveListen = resolve; });
    dht.server.listen = async () => { dht.server.listens += 1; await listening; };
    const host = new peer.PeerShareHost({
      createDht: () => dht,
      createKeyPair: () => ({ publicKey: new Uint8Array(32).fill(3), secretKey: new Uint8Array(64).fill(4) }),
      randomBytes: (length) => new Uint8Array(length).fill(9),
      setTimer: () => 1,
      clearTimer: () => undefined,
    });

    const first = host.start();
    const second = host.start();
    await waitFor(() => dht.server.listens > 0, "peer listener startup");
    expect(dht.server.listens).toBe(1);
    resolveListen?.();
    const [firstShare, secondShare] = await Promise.all([first, second]);
    expect(firstShare).toEqual(secondShare);
    await host.stop();
  });

  it("restores a durable pairing identity after the desktop host restarts", async () => {
    const PeerShareHost = (peer as Record<string, unknown>).PeerShareHost as new (options: {
      readonly createDht: () => FakeDht;
      readonly createKeyPair: () => { readonly publicKey: Uint8Array; readonly secretKey: Uint8Array };
      readonly randomBytes: (length: number) => Uint8Array;
      readonly pairingStore: {
        load(): Promise<{ readonly publicKey: Uint8Array; readonly secretKey: Uint8Array; readonly capability: Uint8Array } | null>;
        save(value: { readonly publicKey: Uint8Array; readonly secretKey: Uint8Array; readonly capability: Uint8Array }): Promise<void>;
      };
      readonly setTimer: (callback: () => void, delay: number) => unknown;
    }) => { start(): Promise<{ readonly invite: string }>; stop(): Promise<void> };
    let saved: { readonly publicKey: Uint8Array; readonly secretKey: Uint8Array; readonly capability: Uint8Array } | null = null;
    const pairingStore = {
      load: async () => saved,
      save: async (value: { readonly publicKey: Uint8Array; readonly secretKey: Uint8Array; readonly capability: Uint8Array }) => { saved = value; },
    };
    const first = new PeerShareHost({
      createDht: () => new FakeDht(),
      createKeyPair: () => ({ publicKey: new Uint8Array(32).fill(3), secretKey: new Uint8Array(64).fill(4) }),
      randomBytes: (length) => new Uint8Array(length).fill(9),
      pairingStore,
      setTimer: () => { throw new Error("durable pairing must not expire"); },
    });
    const firstShare = await first.start();
    await first.stop();

    const second = new PeerShareHost({
      createDht: () => new FakeDht(),
      createKeyPair: () => ({ publicKey: new Uint8Array(32).fill(7), secretKey: new Uint8Array(64).fill(8) }),
      randomBytes: (length) => new Uint8Array(length).fill(6),
      pairingStore,
      setTimer: () => { throw new Error("durable pairing must not expire"); },
    });
    const secondShare = await second.start();

    expect(secondShare.invite).toBe(firstShare.invite);
    await second.stop();
  });

  it("creates an ephemeral invite while keeping its capability out of status", async () => {
    const PeerShareHost = (peer as Record<string, unknown>).PeerShareHost as new (options: {
      readonly createDht: () => FakeDht;
      readonly createKeyPair: () => { readonly publicKey: Uint8Array; readonly secretKey: Uint8Array };
      readonly randomBytes: (length: number) => Uint8Array;
      readonly now: () => number;
      readonly setTimer: (callback: () => void, delay: number) => unknown;
      readonly clearTimer: (timer: unknown) => void;
    }) => {
      start(): Promise<{ readonly invite: string }>;
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
    await waitForWrites(socket, 1);

    const frames = new PeerWireDecoder().push(socket.writes[0]!);
    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({ type: "challenge" });
    expect(frames[0]?.type === "challenge" && frames[0].nonce.length > 0).toBe(true);
    await host.stop();
  });

  it("authorizes only the holder of the invite capability", async () => {
    const PeerShareHost = (peer as Record<string, unknown>).PeerShareHost as new (options: {
      readonly createDht: () => FakeDht;
      readonly createKeyPair: () => { readonly publicKey: Uint8Array; readonly secretKey: Uint8Array };
      readonly randomBytes: (length: number) => Uint8Array;
      readonly createAppserverTransport: () => Promise<FakeOmpTransport>;
      readonly setTimer: (callback: () => void, delay: number) => unknown;
      readonly clearTimer: (timer: unknown) => void;
    }) => { start(): Promise<unknown>; stop(): Promise<void> };
    const dht = new FakeDht();
    const desktopPublicKey = new Uint8Array(32).fill(3);
    let randomCall = 0;
    const host = new PeerShareHost({
      createDht: () => dht,
      createKeyPair: () => ({ publicKey: desktopPublicKey, secretKey: new Uint8Array(64).fill(4) }),
      randomBytes: (length) => new Uint8Array(length).fill(++randomCall),
      createAppserverTransport: async () => new FakeOmpTransport(),
      setTimer: () => 1,
      clearTimer: () => undefined,
    });
    await host.start();
    const socket = new FakePeerSocket();
    dht.server.connection?.(socket);
    socket.send(encodePeerWireFrame({ type: "hello", version: 1, nonce: "client-nonce" }));
    await waitForWrites(socket, 1);
    const challenge = new PeerWireDecoder().push(socket.writes[0]!)[0];
    if (challenge?.type !== "challenge") throw new Error("missing challenge");
    const proof = createHmac("sha256", Buffer.alloc(32, 1))
      .update("t4peer/v1\0")
      .update("client-nonce")
      .update(challenge.nonce)
      .update(desktopPublicKey)
      .digest("base64url");

    socket.send(encodePeerWireFrame({ type: "authorize", proof }));
    await waitForWrites(socket, 2);

    expect(new PeerWireDecoder().push(socket.writes[1]!)).toEqual([{ type: "authorized" }]);
    expect(socket.destroyed).toBe(false);
    await host.stop();
  });

  it("handles approved workspace controls only after peer authorization", async () => {
    const dht = new FakeDht();
    const desktopPublicKey = new Uint8Array(32).fill(3);
    const calls: string[] = [];
    const host = new peer.PeerShareHost({
      createDht: () => dht,
      createKeyPair: () => ({ publicKey: desktopPublicKey, secretKey: new Uint8Array(64).fill(4) }),
      randomBytes: (length) => new Uint8Array(length).fill(1),
      createAppserverTransport: async () => new FakeOmpTransport(),
      workspaceRoots: {
        list: async () => ({ roots: [{ id: "root-1", label: "Projects" }], activeRootId: "root-1" }),
        selectRoot: async (id) => { calls.push(`select:${id}`); },
        createProject: async (name) => { calls.push(`create:${name}`); return { id: "/approved/mobile-app", name }; },
      },
      setTimer: () => 1,
      clearTimer: () => undefined,
    });
    await host.start();
    const socket = new FakePeerSocket();
    dht.server.connection?.(socket);
    socket.send(encodePeerWireFrame({ type: "hello", version: 1, nonce: "mobile" }));
    await waitForWrites(socket, 1);
    const challenge = new PeerWireDecoder().push(socket.writes[0]!)[0];
    if (challenge?.type !== "challenge") throw new Error("missing challenge");
    const proof = createHmac("sha256", Buffer.alloc(32, 1)).update("t4peer/v1\0").update("mobile").update(challenge.nonce).update(desktopPublicKey).digest("base64url");
    socket.send(encodePeerWireFrame({ type: "authorize", proof }));
    await waitForWrites(socket, 2);
    socket.send(encodePeerWireFrame({ type: "workspace", requestId: "folders", operation: "roots.list" }));
    await waitForWrites(socket, 3);
    expect(new PeerWireDecoder().push(socket.writes[2]!)).toEqual([{ type: "workspace-result", requestId: "folders", ok: true, roots: [{ id: "root-1", label: "Projects" }], activeRootId: "root-1" }]);
    socket.send(encodePeerWireFrame({ type: "workspace", requestId: "project", operation: "project.create", name: "mobile-app" }));
    await waitForWrites(socket, 4);
    expect(new PeerWireDecoder().push(socket.writes[3]!)).toEqual([{ type: "workspace-result", requestId: "project", ok: true, project: { id: "/approved/mobile-app", name: "mobile-app" } }]);
    expect(calls).toEqual(["create:mobile-app"]);
    await host.stop();
  });

  it("rejects an invalid capability proof before opening an OMP connection", async () => {
    const PeerShareHost = (peer as Record<string, unknown>).PeerShareHost as new (options: {
      readonly createDht: () => FakeDht;
      readonly createKeyPair: () => { readonly publicKey: Uint8Array; readonly secretKey: Uint8Array };
      readonly randomBytes: (length: number) => Uint8Array;
      readonly createAppserverTransport: () => Promise<FakeOmpTransport>;
      readonly setTimer: (callback: () => void, delay: number) => unknown;
      readonly clearTimer: (timer: unknown) => void;
    }) => { start(): Promise<unknown>; stop(): Promise<void> };
    const dht = new FakeDht();
    let opens = 0;
    const host = new PeerShareHost({
      createDht: () => dht,
      createKeyPair: () => ({ publicKey: new Uint8Array(32).fill(3), secretKey: new Uint8Array(64).fill(4) }),
      randomBytes: (length) => new Uint8Array(length).fill(1),
      createAppserverTransport: async () => {
        opens += 1;
        return new FakeOmpTransport();
      },
      setTimer: () => 1,
      clearTimer: () => undefined,
    });
    await host.start();
    const socket = new FakePeerSocket();
    dht.server.connection?.(socket);
    socket.send(encodePeerWireFrame({ type: "hello", version: 1, nonce: "client-nonce" }));
    await waitForWrites(socket, 1);
    socket.send(encodePeerWireFrame({ type: "authorize", proof: "not-the-capability-proof" }));

    await waitFor(() => socket.destroyed, "invalid proof rejection");
    expect(opens).toBe(0);
    await host.stop();
  });

  it("keeps multiple authorized phones connected through the same pairing", async () => {
    const PeerShareHost = (peer as Record<string, unknown>).PeerShareHost as new (options: {
      readonly createDht: () => FakeDht;
      readonly createKeyPair: () => { readonly publicKey: Uint8Array; readonly secretKey: Uint8Array };
      readonly randomBytes: (length: number) => Uint8Array;
      readonly createAppserverTransport: () => Promise<FakeOmpTransport>;
      readonly setTimer: (callback: () => void, delay: number) => unknown;
      readonly clearTimer: (timer: unknown) => void;
    }) => { start(): Promise<unknown>; stop(): Promise<void> };
    const dht = new FakeDht();
    const desktopPublicKey = new Uint8Array(32).fill(3);
    let randomCall = 0;
    let opens = 0;
    const host = new PeerShareHost({
      createDht: () => dht,
      createKeyPair: () => ({ publicKey: desktopPublicKey, secretKey: new Uint8Array(64).fill(4) }),
      randomBytes: (length) => new Uint8Array(length).fill(++randomCall),
      createAppserverTransport: async () => {
        opens += 1;
        return new FakeOmpTransport();
      },
      setTimer: () => 1,
      clearTimer: () => undefined,
    });
    await host.start();

    const authorize = async (socket: FakePeerSocket, nonce: string): Promise<void> => {
      dht.server.connection?.(socket);
      socket.send(encodePeerWireFrame({ type: "hello", version: 1, nonce }));
      await waitForWrites(socket, 1);
      const challenge = new PeerWireDecoder().push(socket.writes[0]!)[0];
      if (challenge?.type !== "challenge") throw new Error("missing challenge");
      const proof = createHmac("sha256", Buffer.alloc(32, 1))
        .update("t4peer/v1\0")
        .update(nonce)
        .update(challenge.nonce)
        .update(desktopPublicKey)
        .digest("base64url");
      socket.send(encodePeerWireFrame({ type: "authorize", proof }));
    };

    const first = new FakePeerSocket();
    await authorize(first, "first-phone");
    await waitForWrites(first, 2);
    const second = new FakePeerSocket();
    await authorize(second, "second-phone");

    await waitForWrites(second, 2);
    expect(opens).toBe(2);
    expect(first.destroyed).toBe(false);
    expect(second.destroyed).toBe(false);
    await host.stop();
  });

  it("rejects a fifth authorized phone without opening another OMP transport", async () => {
    const PeerShareHost = (peer as Record<string, unknown>).PeerShareHost as new (options: {
      readonly createDht: () => FakeDht;
      readonly createKeyPair: () => { readonly publicKey: Uint8Array; readonly secretKey: Uint8Array };
      readonly randomBytes: (length: number) => Uint8Array;
      readonly createAppserverTransport: () => Promise<FakeOmpTransport>;
      readonly setTimer: (callback: () => void, delay: number) => unknown;
      readonly clearTimer: (timer: unknown) => void;
    }) => { start(): Promise<unknown>; stop(): Promise<void> };
    const dht = new FakeDht();
    const desktopPublicKey = new Uint8Array(32).fill(3);
    let randomCall = 0;
    let opens = 0;
    const host = new PeerShareHost({
      createDht: () => dht,
      createKeyPair: () => ({ publicKey: desktopPublicKey, secretKey: new Uint8Array(64).fill(4) }),
      randomBytes: (length) => new Uint8Array(length).fill(++randomCall),
      createAppserverTransport: async () => {
        opens += 1;
        return new FakeOmpTransport();
      },
      setTimer: () => 1,
      clearTimer: () => undefined,
    });
    await host.start();

    const authorize = async (socket: FakePeerSocket, nonce: string): Promise<void> => {
      dht.server.connection?.(socket);
      socket.send(encodePeerWireFrame({ type: "hello", version: 1, nonce }));
      await waitForWrites(socket, 1);
      const challenge = new PeerWireDecoder().push(socket.writes[0]!)[0];
      if (challenge?.type !== "challenge") throw new Error("missing challenge");
      const proof = createHmac("sha256", Buffer.alloc(32, 1))
        .update("t4peer/v1\0")
        .update(nonce)
        .update(challenge.nonce)
        .update(desktopPublicKey)
        .digest("base64url");
      socket.send(encodePeerWireFrame({ type: "authorize", proof }));
    };

    const phones = Array.from({ length: 5 }, () => new FakePeerSocket());
    for (const [index, phone] of phones.entries()) await authorize(phone, `phone-${index}`);
    await waitFor(() => phones.slice(0, 4).every((phone) => phone.writes.length >= 2), "four authorized phones");
    await waitFor(() => phones[4]!.destroyed, "fifth phone rejection");

    expect(opens).toBe(4);
    expect(phones.slice(0, 4).every((phone) => !phone.destroyed)).toBe(true);
    await host.stop();
  });

  it("relays OMP messages only after authorization", async () => {
    const PeerShareHost = (peer as Record<string, unknown>).PeerShareHost as new (options: {
      readonly createDht: () => FakeDht;
      readonly createKeyPair: () => { readonly publicKey: Uint8Array; readonly secretKey: Uint8Array };
      readonly randomBytes: (length: number) => Uint8Array;
      readonly createAppserverTransport: () => Promise<FakeOmpTransport>;
      readonly setTimer: (callback: () => void, delay: number) => unknown;
      readonly clearTimer: (timer: unknown) => void;
    }) => { start(): Promise<unknown>; stop(): Promise<void> };
    const dht = new FakeDht();
    const upstream = new FakeOmpTransport();
    const desktopPublicKey = new Uint8Array(32).fill(3);
    let randomCall = 0;
    const host = new PeerShareHost({
      createDht: () => dht,
      createKeyPair: () => ({ publicKey: desktopPublicKey, secretKey: new Uint8Array(64).fill(4) }),
      randomBytes: (length) => new Uint8Array(length).fill(++randomCall),
      createAppserverTransport: async () => upstream,
      setTimer: () => 1,
      clearTimer: () => undefined,
    });
    await host.start();
    const socket = new FakePeerSocket();
    dht.server.connection?.(socket);
    socket.send(encodePeerWireFrame({ type: "hello", version: 1, nonce: "client-nonce" }));
    await waitForWrites(socket, 1);
    const challenge = new PeerWireDecoder().push(socket.writes[0]!)[0];
    if (challenge?.type !== "challenge") throw new Error("missing challenge");
    const proof = createHmac("sha256", Buffer.alloc(32, 1))
      .update("t4peer/v1\0")
      .update("client-nonce")
      .update(challenge.nonce)
      .update(desktopPublicKey)
      .digest("base64url");
    socket.send(encodePeerWireFrame({ type: "authorize", proof }));
    await waitForWrites(socket, 2);
    socket.send(encodePeerWireFrame({ type: "message", data: "{\"type\":\"ping\"}" }));
    await waitFor(() => upstream.sent.length === 1, "forwarded OMP message");

    expect(upstream.sent).toEqual(["{\"type\":\"ping\"}"]);
    upstream.emitMessage("{\"type\":\"pong\"}");
    expect(new PeerWireDecoder().push(socket.writes.at(-1)!)).toEqual([
      { type: "message", data: "{\"type\":\"pong\"}" },
    ]);
    await host.stop();
  });
});
