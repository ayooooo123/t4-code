import WebSocket from "ws";
import { MAX_INBOUND_BYTES, type OmpTransport } from "@t4-code/client";
import type { RemoteTargetRecord } from "./registry.ts";

export interface RemoteWebSocketTransportOptions {
  readonly target: RemoteTargetRecord;
  readonly handshakeTimeoutMs?: number;
  readonly idleTimeoutMs?: number;
  readonly maxQueuedBytes?: number;
}

const MAX_OUTBOUND_PAYLOAD_BYTES = 1_048_576;

function endpoint(target: RemoteTargetRecord): string {
  if (target.mode === "serve") {
    const url = new URL(target.address);
    url.pathname = "/v1/ws";
    return url.toString();
  }
  const address = target.address.includes(":") && !target.address.startsWith("[") ? `[${target.address}]` : target.address;
  return `ws://${address}:${target.port}/v1/ws`;
}

export class RemoteWebSocketTransport implements OmpTransport {
  private readonly url: string;
  private readonly handshakeTimeoutMs: number;
  private readonly idleTimeoutMs: number;
  private readonly maxQueuedBytes: number;
  private readonly messages = new Set<(data: string | Uint8Array) => void>();
  private readonly closes = new Set<(code?: number, reason?: string) => void>();
  private readonly errors = new Set<(error: unknown) => void>();
  private socket: WebSocket | undefined;
  private generation = 0;
  private queued: string[] = [];
  private queuedBytes = 0;
  private idleTimer: ReturnType<typeof setTimeout> | undefined;
  private closed = false;
  private closeNotified = false;

  constructor(options: RemoteWebSocketTransportOptions) {
    this.url = endpoint(options.target);
    this.handshakeTimeoutMs = options.handshakeTimeoutMs ?? 10_000;
    this.idleTimeoutMs = options.idleTimeoutMs ?? 60_000;
    this.maxQueuedBytes = options.maxQueuedBytes ?? MAX_OUTBOUND_PAYLOAD_BYTES;
  }

  open(): Promise<void> {
    if (this.closed) return Promise.reject(new Error("remote transport is closed"));
    const generation = ++this.generation;
    const { promise, resolve, reject } = Promise.withResolvers<void>();
    const socket = new WebSocket(this.url, { perMessageDeflate: false, maxPayload: MAX_INBOUND_BYTES, handshakeTimeout: this.handshakeTimeoutMs });
    this.socket = socket;
    const timer = setTimeout(() => {
      if (generation === this.generation && socket.readyState === WebSocket.CONNECTING) socket.terminate();
      reject(new Error("remote websocket handshake timed out"));
    }, this.handshakeTimeoutMs + 100);
    const resetIdle = () => {
      if (this.idleTimer !== undefined) clearTimeout(this.idleTimer);
      this.idleTimer = setTimeout(() => socket.terminate(), this.idleTimeoutMs);
    };
    socket.on("open", () => {
      clearTimeout(timer);
      if (generation !== this.generation || this.closed) { socket.close(); return; }
      resetIdle();
      for (const value of this.queued) socket.send(value);
      this.queued = [];
      this.queuedBytes = 0;
      resolve();
    });
    socket.on("message", (data, binary) => {
      if (generation !== this.generation) return;
      resetIdle();
      const payload = binary ? new Uint8Array(data as Buffer) : data.toString();
      for (const listener of this.messages) listener(payload);
    });
    socket.on("close", (code, reason) => {
      clearTimeout(timer);
      if (this.idleTimer !== undefined) clearTimeout(this.idleTimer);
      if (generation !== this.generation) return;
      this.socket = undefined;
      if (!this.closeNotified) {
        this.closeNotified = true;
        const text = reason.toString("utf8").slice(0, 256);
        for (const listener of this.closes) listener(code, text);
      }
    });
    socket.on("error", () => {
      if (generation !== this.generation) return;
      const error = new Error("remote websocket transport error");
      for (const listener of this.errors) listener(error);
      reject(error);
    });
    return promise;
  }

  send(data: string): void {
    const bytes = Buffer.byteLength(data, "utf8");
    if (bytes > MAX_OUTBOUND_PAYLOAD_BYTES || this.queuedBytes + bytes > this.maxQueuedBytes) throw new Error("remote transport send queue is full");
    const socket = this.socket;
    if (socket?.readyState === WebSocket.OPEN) { socket.send(data); return; }
    if (this.closed) throw new Error("remote transport is closed");
    this.queued.push(data);
    this.queuedBytes += bytes;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.generation += 1;
    if (this.idleTimer !== undefined) clearTimeout(this.idleTimer);
    const socket = this.socket;
    this.socket = undefined;
    this.queued = [];
    this.queuedBytes = 0;
    if (socket !== undefined) {
      socket.removeAllListeners();
      socket.close(1000, "client closed");
      socket.terminate();
    }
    this.messages.clear();
    this.closes.clear();
    this.errors.clear();
  }

  onMessage(listener: (data: string | Uint8Array) => void): () => void { this.messages.add(listener); return () => this.messages.delete(listener); }
  onClose(listener: (code?: number, reason?: string) => void): () => void { this.closes.add(listener); return () => this.closes.delete(listener); }
  onError(listener: (error: unknown) => void): () => void { this.errors.add(listener); return () => this.errors.delete(listener); }
}

export function createRemoteWebSocketTransport(options: RemoteWebSocketTransportOptions): RemoteWebSocketTransport {
  return new RemoteWebSocketTransport(options);
}
