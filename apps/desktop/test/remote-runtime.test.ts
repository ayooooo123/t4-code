import { describe, expect, it } from "vitest";
import { DeviceCredentialStore, VersionedRemoteTargetRegistry, redactRemoteDiagnostics, type RemoteTargetRecord } from "../src/remote-runtime/index.ts";

class Store { value: unknown; constructor(value: unknown) { this.value = value; } read(): unknown { return this.value; } write(value: unknown): void { this.value = value; } }
class Crypto { readonly isEncryptionAvailable = () => true; encryptString(value: string): Buffer { return Buffer.from(value, "utf8"); } decryptString(value: Buffer): string { return value.toString("utf8"); } }
const token = "A".repeat(43);
const deviceId = "device-01";
const target = (targetId: string, address = "100.64.0.1"): RemoteTargetRecord => ({ targetId, label: "Bunker", mode: "direct", address, port: 4210, requestedCapabilities: ["sessions.read"], grantedCapabilities: [], status: "unknown" });
async function fails(operation: () => unknown | Promise<unknown>): Promise<boolean> { try { await operation(); return false; } catch { return true; } }

describe("remote target runtime", () => {
  it("validates direct/serve targets, IPv6 scope, and rejects duplicates/public addresses", async () => {
    const store = new Store({ version: 1, records: [] });
    const registry = new VersionedRemoteTargetRegistry(store);
    await registry.put(target("bunker"));
    expect(await fails(() => registry.put(target("other")))).toBe(true);
    await registry.put({ ...target("serve"), mode: "serve", address: "wss://host.ts.net/", port: 443 });
    await registry.put({ ...target("tailnet-v6"), address: "fd7a:115c:a1e0::1" });
    expect(await fails(() => registry.put({ ...target("public"), address: "8.8.8.8" }))).toBe(true);
    expect(await fails(() => registry.put({ ...target("lan"), address: "192.168.1.2" }))).toBe(true);
    expect(await fails(() => registry.put({ ...target("bad"), mode: "serve", address: "https://host.ts.net/?token=x" }))).toBe(true);
    expect(await fails(() => registry.put({ ...target("local:fable-swarm"), address: "100.64.0.4" }))).toBe(true);
  });
  it("serializes concurrent mutations and keeps credentials encrypted", async () => {
    const targetStore = new Store({ version: 1, records: [] });
    const registry = new VersionedRemoteTargetRegistry(targetStore);
    await Promise.all([registry.put({ ...target("one"), address: "100.64.0.2" }), registry.put({ ...target("two"), address: "100.64.0.3" })]);
    expect((await registry.list()).length).toBe(2);
    const store = new Store({ version: 1, ciphertexts: {} });
    const credentials = new DeviceCredentialStore(store, new Crypto());
    await credentials.set("remote", { token, deviceId });
    // oxlint-disable-next-line unicorn/no-thenable -- intentionally verifies thenable rejection
    expect(await fails(() => credentials.withCredential("remote", () => Object.defineProperty({}, "then", { value: () => undefined } as PropertyDescriptor)))).toBe(true);
    expect(await credentials.withCredential("remote", (value) => value.deviceId)).toBe(deviceId);
    await credentials.revoke("remote");
    expect(await fails(() => credentials.withCredential("remote", (value) => value.token))).toBe(true);
  });
  it("fails closed for unavailable encryption and redacts recursive diagnostics", () => {
    expect(() => new DeviceCredentialStore(new Store({ version: 1, ciphertexts: {} }), { isEncryptionAvailable: () => false, encryptString: () => Buffer.alloc(0), decryptString: () => "" })).toThrow();
    expect(() => new DeviceCredentialStore(new Store({ version: 1, ciphertexts: {} }), { isEncryptionAvailable: () => true, selectedStorageBackend: () => "basic_text", encryptString: () => Buffer.alloc(0), decryptString: () => "" })).toThrow();
    expect(redactRemoteDiagnostics({ token, nested: [{ ciphertext: "secret" }] })).toEqual({ token: "[redacted]", nested: [{ ciphertext: "[redacted]" }] });
  });
});
