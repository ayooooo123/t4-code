import { createServer as createHttpServer } from "node:http";
import { chmodSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer as createNetServer, type Server, type Socket } from "node:net";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";
import { RemoteWebSocketTransport } from "../src/remote-runtime/transport.ts";
import { resolveUnixSocketPath, UnixWebSocketTransport } from "../src/transport.ts";

const describeUnix = process.platform === "linux" || process.platform === "darwin" ? describe : (_name: string, _fn: () => void): void => {};
const UUID = "123e4567-e89b-12d3-a456-426614174000";
const FIXTURE_TMP_ROOT = process.platform === "darwin" ? "/private/tmp" : tmpdir();

function fixtureDirectory(): string {
  const directory = mkdtempSync(join(FIXTURE_TMP_ROOT, "t4-transport-"));
  chmodSync(directory, 0o700);
  return directory;
}

async function listenUnix(server: Server, path: string): Promise<void> {
  server.listen(path);
  await once(server, "listening");
  chmodSync(path, 0o600);
}

async function closeServer(server: Server): Promise<void> {
  if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
}

describeUnix("Unix socket ownership and resolution", () => {
  it("accepts a direct socket and returns the same path", async () => {
    const directory = fixtureDirectory();
    const socketPath = join(directory, "direct.sock");
    const server = createNetServer();
    try {
      await listenUnix(server, socketPath);
      expect(resolveUnixSocketPath(socketPath)).toBe(socketPath);
    } finally {
      await closeServer(server);
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("accepts an OMP public link and resolves its same-directory backing socket", async () => {
    const directory = fixtureDirectory();
    const backingName = `.appserver-${UUID}.sock`;
    const backingPath = join(directory, backingName);
    const publicPath = join(directory, "appserver.sock");
    const server = createNetServer();
    try {
      await listenUnix(server, backingPath);
      symlinkSync(backingName, publicPath);
      expect(resolveUnixSocketPath(publicPath)).toBe(backingPath);
    } finally {
      await closeServer(server);
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("opens a WebSocket through an OMP public link using the resolved backing path", async () => {
    const directory = fixtureDirectory();
    const backingName = `.appserver-${UUID}.sock`;
    const backingPath = join(directory, backingName);
    const publicPath = join(directory, "appserver.sock");
    const httpServer = createHttpServer();
    const webSocketServer = new WebSocketServer({ server: httpServer });
    webSocketServer.on("connection", (socket) => socket.close());
    const transport = new UnixWebSocketTransport({ socketPath: publicPath });
    try {
      httpServer.listen(backingPath);
      await once(httpServer, "listening");
      chmodSync(backingPath, 0o600);
      symlinkSync(backingName, publicPath);
      await transport.open();
    } finally {
      transport.close();
      await new Promise<void>((resolve) => webSocketServer.close(() => resolve()));
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("accepts an OMP snapshot frame larger than one MiB", async () => {
    const directory = fixtureDirectory();
    const socketPath = join(directory, "large-snapshot.sock");
    const httpServer = createHttpServer();
    const webSocketServer = new WebSocketServer({ server: httpServer });
    const payload = "x".repeat(1_048_576 + 1_024);
    webSocketServer.on("connection", (socket) => socket.send(payload));
    const transport = new UnixWebSocketTransport({ socketPath, validatePath: false });
    const received = new Promise<string>((resolve, reject) => {
      transport.onMessage((data) => resolve(typeof data === "string" ? data : Buffer.from(data).toString()));
      transport.onError(() => reject(new Error("transport rejected the snapshot frame")));
      transport.onClose(() => reject(new Error("transport closed before delivering the snapshot frame")));
    });
    try {
      httpServer.listen(socketPath);
      await once(httpServer, "listening");
      await transport.open();
      expect(await received).toHaveLength(payload.length);
    } finally {
      transport.close();
      await new Promise<void>((resolve) => webSocketServer.close(() => resolve()));
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("bounds a local WebSocket handshake that never answers", async () => {
    const directory = fixtureDirectory();
    const socketPath = join(directory, "stalled.sock");
    const sockets = new Set<Socket>();
    const server = createNetServer((socket) => {
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
    });
    const transport = new UnixWebSocketTransport({
      socketPath,
      validatePath: false,
      handshakeTimeoutMs: 25,
    });
    try {
      await listenUnix(server, socketPath);
      await expect(transport.open()).rejects.toThrow("handshake timed out");
    } finally {
      transport.close();
      for (const socket of sockets) socket.destroy();
      await closeServer(server);
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rejects absolute, traversal, malformed, and symlink-to-symlink targets", async () => {
    const directory = fixtureDirectory();
    const publicPath = join(directory, "appserver.sock");
    const cases = [
      "/tmp/other.sock",
      "../other.sock",
      ".appserver-not-a-uuid.sock",
      `.appserver-${UUID}.sock/../other.sock`,
    ];
    try {
      for (const target of cases) {
        symlinkSync(target, publicPath);
        expect(() => resolveUnixSocketPath(publicPath)).toThrow();
        rmSync(publicPath, { force: true });
      }

      const actualPath = join(directory, "actual.sock");
      const backingPath = join(directory, `.appserver-${UUID}.sock`);
      writeFileSync(actualPath, "not a socket", { mode: 0o600 });
      symlinkSync(actualPath, backingPath);
      symlinkSync(`.appserver-${UUID}.sock`, publicPath);
      expect(() => resolveUnixSocketPath(publicPath)).toThrow();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rejects non-sockets and group/world-writable parents or sockets", async () => {
    const directory = fixtureDirectory();
    const publicPath = join(directory, "appserver.sock");
    const backingPath = join(directory, `.appserver-${UUID}.sock`);
    try {
      writeFileSync(backingPath, "not a socket", { mode: 0o600 });
      symlinkSync(`.appserver-${UUID}.sock`, publicPath);
      expect(() => resolveUnixSocketPath(publicPath)).toThrow();
      rmSync(publicPath, { force: true });
      rmSync(backingPath, { force: true });

      const server = createNetServer();
      await listenUnix(server, backingPath);
      chmodSync(backingPath, 0o620);
      symlinkSync(`.appserver-${UUID}.sock`, publicPath);
      expect(() => resolveUnixSocketPath(publicPath)).toThrow();
      rmSync(publicPath, { force: true });
      chmodSync(backingPath, 0o600);
      chmodSync(directory, 0o770);
      expect(() => resolveUnixSocketPath(backingPath)).toThrow();
      await closeServer(server);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rejects a public symlink whose parent path contains a symlink", async () => {
    const directory = fixtureDirectory();
    const linkedDirectory = join(directory, "linked");
    const publicPath = join(linkedDirectory, "appserver.sock");
    const backingPath = join(directory, `.appserver-${UUID}.sock`);
    const server = createNetServer();
    try {
      await listenUnix(server, backingPath);
      symlinkSync(directory, linkedDirectory);
      expect(() => resolveUnixSocketPath(publicPath)).toThrow();
    } finally {
      await closeServer(server);
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe("remote WebSocket transport", () => {
  it("accepts an OMP snapshot frame larger than one MiB", async () => {
    const httpServer = createHttpServer();
    const webSocketServer = new WebSocketServer({ server: httpServer });
    const payload = "x".repeat(1_048_576 + 1_024);
    webSocketServer.on("connection", (socket) => socket.send(payload));
    httpServer.listen(0, "127.0.0.1");
    await once(httpServer, "listening");
    const port = (httpServer.address() as AddressInfo).port;
    const transport = new RemoteWebSocketTransport({
      target: {
        targetId: "test-remote",
        label: "Test remote",
        mode: "direct",
        address: "127.0.0.1",
        port,
        requestedCapabilities: [],
        grantedCapabilities: [],
        status: "unknown",
      },
    });
    const received = new Promise<string>((resolve, reject) => {
      transport.onMessage((data) => resolve(typeof data === "string" ? data : Buffer.from(data).toString()));
      transport.onError(() => reject(new Error("transport rejected the snapshot frame")));
      transport.onClose(() => reject(new Error("transport closed before delivering the snapshot frame")));
    });
    try {
      await transport.open();
      expect(await received).toHaveLength(payload.length);
    } finally {
      transport.close();
      await new Promise<void>((resolve) => webSocketServer.close(() => resolve()));
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    }
  });
});
