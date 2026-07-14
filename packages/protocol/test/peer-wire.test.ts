import { describe, expect, it } from "vite-plus/test";
import * as protocol from "../src/index.ts";

describe("peer wire framing", () => {
  it("decodes a length-framed handshake split across reads", () => {
    const encodePeerWireFrame = (protocol as Record<string, unknown>).encodePeerWireFrame as (
      frame: unknown,
    ) => Uint8Array;
    const PeerWireDecoder = (protocol as Record<string, unknown>).PeerWireDecoder as new () => {
      push(value: Uint8Array): unknown[];
    };
    const encoded = encodePeerWireFrame({ type: "hello", version: 1, nonce: "nonce-1" });
    const decoder = new PeerWireDecoder();

    expect(decoder.push(encoded.slice(0, 3))).toEqual([]);
    expect(decoder.push(encoded.slice(3))).toEqual([{ type: "hello", version: 1, nonce: "nonce-1" }]);
  });

  it("decodes coalesced frames in order", () => {
    const encodePeerWireFrame = (protocol as Record<string, unknown>).encodePeerWireFrame as (
      frame: unknown,
    ) => Uint8Array;
    const PeerWireDecoder = (protocol as Record<string, unknown>).PeerWireDecoder as new () => {
      push(value: Uint8Array): unknown[];
    };
    const first = encodePeerWireFrame({ type: "authorized" });
    const second = encodePeerWireFrame({ type: "message", data: "{\"type\":\"hello\"}" });
    const combined = new Uint8Array(first.byteLength + second.byteLength);
    combined.set(first);
    combined.set(second, first.byteLength);

    expect(new PeerWireDecoder().push(combined)).toEqual([
      { type: "authorized" },
      { type: "message", data: "{\"type\":\"hello\"}" },
    ]);
  });
});
