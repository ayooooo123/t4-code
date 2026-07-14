declare module "hyperdht" {
  interface HyperDhtKeyPair {
    readonly publicKey: Uint8Array;
    readonly secretKey: Uint8Array;
  }

  interface HyperDhtServer {
    listen(keyPair: HyperDhtKeyPair): Promise<void>;
    close(): Promise<void>;
  }

  export default class HyperDHT {
    constructor(options?: { readonly bootstrap?: readonly string[] });
    static keyPair(): HyperDhtKeyPair;
    createServer(): HyperDhtServer;
    destroy(): Promise<void>;
  }
}
