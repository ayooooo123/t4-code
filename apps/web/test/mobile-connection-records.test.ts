import { describe, expect, it } from "vite-plus/test";

import {
  MobileConnectionUserError,
  parsePeerBackend,
  parseTailnetBackend,
  peerDesktopFingerprint,
  peerDesktopPublicKey,
} from "../src/platform/mobile-connection-records.ts";

const PUBLIC_KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const CAPABILITY = "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBA";
const PUBLIC_INVITE = `t4peer://v1/${PUBLIC_KEY}/${CAPABILITY}`;

function expectPrivatePeerError(value: string): void {
  let error: unknown;
  try {
    parsePeerBackend(value);
  } catch (caught) {
    error = caught;
  }

  expect(error).toBeInstanceOf(MobileConnectionUserError);
  const message = error instanceof Error ? error.message : String(error);
  if (value !== "") expect(message).not.toContain(value);
  expect(message).not.toContain(PUBLIC_INVITE);
  expect(message).not.toContain(CAPABILITY);
  expect(message).not.toContain("invalid peer invite");
}

describe("mobile connection records", () => {
  it("canonicalizes a Tailnet host address", () => {
    expect(parseTailnetBackend("Desk.TAILNET.ts.net:8445")).toEqual({
      version: 1,
      origin: "https://desk.tailnet.ts.net:8445",
      wsUrl: "wss://desk.tailnet.ts.net:8445/v1/ws",
      label: "T4 on desk",
    });
  });

  it.each([
    ["empty", ""],
    ["over 2,048 characters", `https://${"a".repeat(2_049)}.ts.net`],
    ["HTTP", "http://desk.tailnet.ts.net"],
    ["credentials", "https://user:pass@desk.tailnet.ts.net"],
    ["path", "https://desk.tailnet.ts.net/admin"],
    ["query", "https://desk.tailnet.ts.net?private=value"],
    ["fragment", "https://desk.tailnet.ts.net#private"],
    ["bare ts.net", "https://ts.net"],
    ["leading empty DNS label", "https://.ts.net"],
    ["intermediate empty DNS label", "https://foo..ts.net"],
    ["non-Tailnet host", "https://example.com"],
    ["label over 128 characters", `https://${"a".repeat(123)}.tailnet.ts.net`],
  ])("rejects a Tailnet address with %s", (_reason, value) => {
    expect(() => parseTailnetBackend(value)).toThrow(MobileConnectionUserError);
  });

  it("canonicalizes a public peer invite and exposes only its desktop identity", () => {
    expect(parsePeerBackend(` \n${PUBLIC_INVITE}\t `)).toEqual({
      version: 2,
      kind: "peer",
      invite: PUBLIC_INVITE,
      label: "T4 private host AAAAAAAA",
    });
    expect(peerDesktopPublicKey(PUBLIC_INVITE)).toBe(PUBLIC_KEY);
    expect(peerDesktopFingerprint(PUBLIC_INVITE)).toBe("AAAAAAAA");
  });

  it("bounds peer input by raw UTF-8 bytes before trimming or parsing", () => {
    const multibyte = "é".repeat(1_025);
    expect(multibyte.length).toBeLessThanOrEqual(2_048);
    expect(new TextEncoder().encode(multibyte).byteLength).toBeGreaterThan(2_048);

    const paddedInvite = `${" ".repeat(2_049)}${PUBLIC_INVITE}`;
    expect(paddedInvite.trim()).toBe(PUBLIC_INVITE);
    expect(new TextEncoder().encode(paddedInvite).byteLength).toBeGreaterThan(2_048);

    for (const value of [multibyte, paddedInvite]) {
      expectPrivatePeerError(value);
    }
  });

  it.each([
    ["empty", ""],
    ["wrong scheme", PUBLIC_INVITE.replace("t4peer:", "https:")],
    ["wrong version", PUBLIC_INVITE.replace("/v1/", "/v2/")],
    ["short public key", `t4peer://v1/${PUBLIC_KEY.slice(1)}/${CAPABILITY}`],
    ["long public key", `t4peer://v1/${PUBLIC_KEY}A/${CAPABILITY}`],
    ["short capability", `t4peer://v1/${PUBLIC_KEY}/${CAPABILITY.slice(1)}`],
    ["long capability", `t4peer://v1/${PUBLIC_KEY}/${CAPABILITY}A`],
  ])("rejects a peer invite with %s using a controlled private error", (_reason, value) => {
    expectPrivatePeerError(value);
  });
});
