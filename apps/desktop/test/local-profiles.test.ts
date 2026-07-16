import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_LOCAL_PROFILE,
  LocalProfileRegistry,
  decodeLocalProfileRecord,
  discoverNativeOmpProfiles,
  type LocalProfileRegistryState,
  type LocalProfileStore,
} from "../src/local-profiles.ts";
import { localSocketPath } from "../src/socket-path.ts";

class MemoryStore implements LocalProfileStore {
  value: unknown;

  constructor(value: unknown = {
    version: 1,
    records: [DEFAULT_LOCAL_PROFILE],
    ignoredProfileIds: [],
  }) {
    this.value = value;
  }

  read(): unknown { return this.value; }
  async write(value: LocalProfileRegistryState): Promise<void> { this.value = value; }
}

describe("local OMP profile registry", () => {
  it("imports only native profile layouts and preserves their labels", async () => {
    const home = await mkdtemp(join(tmpdir(), "t4-profiles-"));
    const omp = join(home, ".omp");
    const fableAgent = join(omp, "profiles", "fable-swarm", "agent");
    const scoutAgent = join(omp, "profiles", "gemini-scout", "agent");
    try {
      await mkdir(join(omp, "home"), { recursive: true });
      await mkdir(fableAgent, { recursive: true });
      await mkdir(scoutAgent, { recursive: true });
      await writeFile(join(fableAgent, "config.yml"), "defaultModel: anthropic/fable-5\n");
      await writeFile(join(scoutAgent, "config.yml"), "defaultModel: google/gemini-3.5-flash\n");
      await writeFile(join(omp, "home", "profiles.json"), JSON.stringify({
        version: 1,
        profiles: [
          { id: "fable-swarm", label: "Fable Swarm", agentDir: fableAgent },
          { id: "outside", label: "Outside", agentDir: join(home, "outside") },
        ],
      }));

      expect(await discoverNativeOmpProfiles({ homeDirectory: home })).toEqual([
        DEFAULT_LOCAL_PROFILE,
        { profileId: "fable-swarm", label: "Fable Swarm", autoStart: false },
        { profileId: "gemini-scout", label: "Gemini Scout", autoStart: false },
      ]);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("keeps default immutable and tombstones a removed discovered profile", async () => {
    const store = new MemoryStore();
    const discovered = Object.freeze([
      DEFAULT_LOCAL_PROFILE,
      { profileId: "fable-swarm", label: "Fable Swarm", autoStart: false },
    ]);
    const registry = new LocalProfileRegistry(store, async () => discovered);

    expect(await registry.list()).toEqual(discovered);
    await expect(registry.update("default", { autoStart: false })).rejects.toThrow(
      "default profile is immutable",
    );
    await expect(registry.remove("default")).rejects.toThrow("default profile is immutable");

    await registry.remove("fable-swarm");
    expect(await registry.list()).toEqual([DEFAULT_LOCAL_PROFILE]);
    expect((store.value as LocalProfileRegistryState).ignoredProfileIds).toEqual(["fable-swarm"]);

    await registry.add({ profileId: "fable-swarm", label: "Claude Burn", autoStart: true });
    expect(await registry.get("fable-swarm")).toEqual({
      profileId: "fable-swarm",
      label: "Claude Burn",
      autoStart: true,
    });
    expect((store.value as LocalProfileRegistryState).ignoredProfileIds).toEqual([]);
  });

  it("rejects malformed persisted labels and matches OMP's profile socket aliases", () => {
    expect(() => decodeLocalProfileRecord({
      profileId: "fable-swarm",
      label: "",
      autoStart: false,
    })).toThrow("invalid local profile label");
    expect(localSocketPath({
      platform: "linux",
      homeDirectory: "/home/alice",
      runtimeDirectory: "/run/user/1000",
      profileId: "default",
    })).toBe("/run/user/1000/omp/appserver.sock");
    expect(localSocketPath({
      platform: "linux",
      homeDirectory: "/home/alice",
      runtimeDirectory: "/run/user/1000",
      profileId: "fable-swarm",
    })).toBe("/run/user/1000/omp/appserver-profile-c849f456f0fdbbebadc5f559.sock");
    expect(localSocketPath({
      platform: "darwin",
      homeDirectory: "/Users/alice",
      profileId: "fable-swarm",
    })).toBe("/Users/alice/.omp/run/appserver-profile-c849f456f0fdbbebadc5f559.sock");
  });
});
