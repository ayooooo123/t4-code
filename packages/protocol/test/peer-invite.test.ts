import { describe, expect, it } from "vite-plus/test";
import * as protocol from "../src/index.ts";

describe("peer invite codec", () => {
  it("round-trips a version-one desktop key and capability", () => {
    const desktopPublicKey = new Uint8Array(32).fill(7);
    const capability = new Uint8Array(32).fill(9);
    const encodePeerInvite = (protocol as Record<string, unknown>).encodePeerInvite as (
      value: { readonly desktopPublicKey: Uint8Array; readonly capability: Uint8Array },
    ) => string;
    const decodePeerInvite = (protocol as Record<string, unknown>).decodePeerInvite as (
      value: string,
    ) => { readonly version: number; readonly desktopPublicKey: Uint8Array; readonly capability: Uint8Array };

    const value = encodePeerInvite({ desktopPublicKey, capability });
    const decoded = decodePeerInvite(value);

    expect(value).toMatch(/^t4peer:\/\/v1\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+$/u);
    expect(decoded.version).toBe(1);
    expect(decoded.desktopPublicKey).toEqual(desktopPublicKey);
    expect(decoded.capability).toEqual(capability);
  });

  it("rejects malformed values without exposing the capability", () => {
    const decodePeerInvite = (protocol as Record<string, unknown>).decodePeerInvite as (
      value: string,
    ) => unknown;
    const capability = "this-must-not-appear-in-errors";
    const malformed = `t4peer://v1/not-a-32-byte-key/${capability}`;

    expect(() => decodePeerInvite(malformed)).toThrow("invalid peer invite");
    try {
      decodePeerInvite(malformed);
    } catch (error) {
      expect(String(error)).not.toContain(capability);
    }
  });

  it("publishes safe metadata without the capability", () => {
    const desktopPublicKey = new Uint8Array(32).fill(7);
    const capability = new Uint8Array(32).fill(9);
    const encodePeerInvite = (protocol as Record<string, unknown>).encodePeerInvite as (
      value: { readonly desktopPublicKey: Uint8Array; readonly capability: Uint8Array },
    ) => string;
    const peerInviteMetadata = (protocol as Record<string, unknown>).peerInviteMetadata as (
      value: string,
    ) => unknown;
    const invite = encodePeerInvite({ desktopPublicKey, capability });

    expect(JSON.stringify(peerInviteMetadata(invite))).not.toContain(invite.split("/").at(-1)!);
  });
});
