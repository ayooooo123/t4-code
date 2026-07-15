const MAX_FRAME_BYTES = 4 * 1024 * 1024;
const MAX_TEXT_BYTES = 4 * 1024 * 1024;
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder("utf-8", { fatal: true });

export type PeerWireFrame =
  | { readonly type: "hello"; readonly version: 1; readonly nonce: string }
  | { readonly type: "challenge"; readonly nonce: string }
  | { readonly type: "authorize"; readonly proof: string }
  | { readonly type: "authorized" }
  | { readonly type: "message"; readonly data: string }
  | { readonly type: "workspace"; readonly requestId: string; readonly operation: "roots.list" | "root.select" | "project.create"; readonly rootId?: string; readonly name?: string }
  | { readonly type: "workspace-result"; readonly requestId: string; readonly ok: true; readonly roots?: readonly { readonly id: string; readonly label: string }[]; readonly activeRootId?: string | null; readonly project?: { readonly id: string; readonly name: string } }
  | { readonly type: "workspace-result"; readonly requestId: string; readonly ok: false; readonly error: string }
  | { readonly type: "close"; readonly code: number; readonly reason: string }
  | { readonly type: "error"; readonly code: string };

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid peer frame");
  return value as Record<string, unknown>;
}

function text(value: unknown, maxBytes: number): string {
  if (typeof value !== "string" || value.length === 0 || textEncoder.encode(value).byteLength > maxBytes) {
    throw new Error("invalid peer frame");
  }
  return value;
}

function fields(value: Record<string, unknown>, allowed: readonly string[]): void {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new Error("invalid peer frame");
}

function workspaceRoot(value: unknown): { readonly id: string; readonly label: string } {
  const item = record(value);
  fields(item, ["id", "label"]);
  return { id: text(item.id, 256), label: text(item.label, 256) };
}
function workspaceProject(value: unknown): { readonly id: string; readonly name: string } {
  const item = record(value);
  fields(item, ["id", "name"]);
  return { id: text(item.id, 4 * 1024), name: text(item.name, 256) };
}

export function decodePeerWireFrame(value: unknown): PeerWireFrame {
  const frame = record(value);
  const type = frame.type;
  if (type === "hello") {
    fields(frame, ["type", "version", "nonce"]);
    if (frame.version !== 1) throw new Error("invalid peer frame");
    return { type, version: 1, nonce: text(frame.nonce, 256) };
  }
  if (type === "challenge") {
    fields(frame, ["type", "nonce"]);
    return { type, nonce: text(frame.nonce, 256) };
  }
  if (type === "authorize") {
    fields(frame, ["type", "proof"]);
    return { type, proof: text(frame.proof, 256) };
  }
  if (type === "authorized") {
    fields(frame, ["type"]);
    return { type };
  }
  if (type === "message") {
    fields(frame, ["type", "data"]);
    return { type, data: text(frame.data, MAX_TEXT_BYTES) };
  }
  if (type === "workspace") {
    fields(frame, ["type", "requestId", "operation", "rootId", "name"]);
    const requestId = text(frame.requestId, 256);
    if (frame.operation === "roots.list") {
      if (frame.rootId !== undefined || frame.name !== undefined) throw new Error("invalid peer frame");
      return { type, requestId, operation: frame.operation };
    }
    if (frame.operation === "root.select") {
      if (frame.name !== undefined) throw new Error("invalid peer frame");
      return { type, requestId, operation: frame.operation, rootId: text(frame.rootId, 256) };
    }
    if (frame.operation === "project.create") {
      if (frame.rootId !== undefined) throw new Error("invalid peer frame");
      return { type, requestId, operation: frame.operation, name: text(frame.name, 256) };
    }
    throw new Error("invalid peer frame");
  }
  if (type === "workspace-result") {
    const requestId = text(frame.requestId, 256);
    if (frame.ok === false) {
      fields(frame, ["type", "requestId", "ok", "error"]);
      return { type, requestId, ok: false, error: text(frame.error, 512) };
    }
    fields(frame, ["type", "requestId", "ok", "roots", "activeRootId", "project"]);
    if (frame.ok !== true) throw new Error("invalid peer frame");
    if (frame.roots !== undefined) {
      if (!Array.isArray(frame.roots) || frame.roots.length > 64 || frame.project !== undefined) throw new Error("invalid peer frame");
      if (frame.activeRootId !== null && frame.activeRootId !== undefined && typeof frame.activeRootId !== "string") throw new Error("invalid peer frame");
      return { type, requestId, ok: true, roots: frame.roots.map(workspaceRoot), ...(frame.activeRootId === undefined ? {} : { activeRootId: frame.activeRootId === null ? null : text(frame.activeRootId, 256) }) };
    }
    if (frame.project !== undefined && frame.activeRootId === undefined) return { type, requestId, ok: true, project: workspaceProject(frame.project) };
    throw new Error("invalid peer frame");
  }
  if (type === "close") {
    fields(frame, ["type", "code", "reason"]);
    if (!Number.isInteger(frame.code) || (frame.code as number) < 1000 || (frame.code as number) > 4999) {
      throw new Error("invalid peer frame");
    }
    return { type, code: frame.code as number, reason: text(frame.reason, 256) };
  }
  if (type === "error") {
    fields(frame, ["type", "code"]);
    return { type, code: text(frame.code, 128) };
  }
  throw new Error("invalid peer frame");
}

export function encodePeerWireFrame(frame: PeerWireFrame): Uint8Array {
  const payload = textEncoder.encode(JSON.stringify(decodePeerWireFrame(frame)));
  if (payload.byteLength > MAX_FRAME_BYTES) throw new Error("peer frame too large");
  const encoded = new Uint8Array(payload.byteLength + 4);
  new DataView(encoded.buffer, encoded.byteOffset, encoded.byteLength).setUint32(0, payload.byteLength, false);
  encoded.set(payload, 4);
  return encoded;
}

function append(left: Uint8Array, right: Uint8Array): Uint8Array {
  const output = new Uint8Array(left.byteLength + right.byteLength);
  output.set(left);
  output.set(right, left.byteLength);
  return output;
}

export class PeerWireDecoder {
  private buffered: Uint8Array<ArrayBufferLike> = new Uint8Array();

  push(value: Uint8Array): PeerWireFrame[] {
    if (!(value instanceof Uint8Array)) throw new Error("invalid peer frame chunk");
    this.buffered = append(this.buffered, value);
    if (this.buffered.byteLength > MAX_FRAME_BYTES + 4) {
      this.buffered = new Uint8Array();
      throw new Error("peer frame too large");
    }
    const output: PeerWireFrame[] = [];
    while (this.buffered.byteLength >= 4) {
      const payloadLength = new DataView(
        this.buffered.buffer,
        this.buffered.byteOffset,
        this.buffered.byteLength,
      ).getUint32(0, false);
      if (payloadLength === 0 || payloadLength > MAX_FRAME_BYTES) {
        this.buffered = new Uint8Array();
        throw new Error("invalid peer frame length");
      }
      if (this.buffered.byteLength < payloadLength + 4) break;
      const payload = this.buffered.slice(4, payloadLength + 4);
      this.buffered = this.buffered.slice(payloadLength + 4);
      let parsed: unknown;
      try {
        parsed = JSON.parse(textDecoder.decode(payload));
      } catch {
        throw new Error("invalid peer frame");
      }
      output.push(decodePeerWireFrame(parsed));
    }
    return output;
  }
}
