import { describe, expect, it } from "vite-plus/test";

import { ElectronPeerPairingStore, type PeerPairingCiphertextStore } from "../src/stores.ts";

class MemoryStore implements PeerPairingCiphertextStore {
  value: unknown = { version: 1 };
  read(): unknown { return this.value; }
  async write(value: unknown): Promise<void> { this.value = value; }
}

const cipher = {
  isEncryptionAvailable: () => true,
  selectedStorageBackend: () => "keychain",
  encryptString: (value: string) => Buffer.from(`encrypted:${value}`),
  decryptString: (value: Buffer) => {
    const decoded = value.toString();
    if (!decoded.startsWith("encrypted:")) throw new Error("invalid ciphertext");
    return decoded.slice("encrypted:".length);
  },
};

describe("ElectronPeerPairingStore", () => {
  it("encrypts and restores exact durable pairing bytes", async () => {
    const memory = new MemoryStore();
    const store = new ElectronPeerPairingStore(memory, cipher);
    const pairing = {
      publicKey: new Uint8Array(32).fill(1),
      secretKey: new Uint8Array(64).fill(2),
      capability: new Uint8Array(32).fill(3),
    };

    await store.save(pairing);

    expect(JSON.stringify(memory.value)).not.toContain("AQEBAQ");
    expect(await store.load()).toEqual(pairing);
  });

  it("rejects malformed decrypted pairing material", async () => {
    const memory = new MemoryStore();
    memory.value = {
      version: 1,
      ciphertext: Buffer.from('encrypted:{"version":1,"publicKey":"bad","secretKey":"bad","capability":"bad"}').toString("base64"),
    };
    const store = new ElectronPeerPairingStore(memory, cipher);

    await expect(store.load()).rejects.toThrow("invalid peer pairing");
  });
});
