import { describe, expect, it } from "vitest";
import type { ServiceManager } from "@t4-code/service-manager";
import {
  DEFAULT_LOCAL_PROFILE,
  LocalProfileRegistry,
  type LocalProfileRegistryState,
  type LocalProfileStore,
} from "../src/local-profiles.ts";
import { LocalProfileRuntime } from "../src/profile-runtime.ts";

class MemoryStore implements LocalProfileStore {
  value: unknown = { version: 1, records: [DEFAULT_LOCAL_PROFILE], ignoredProfileIds: [] };
  read(): unknown { return this.value; }
  async write(value: LocalProfileRegistryState): Promise<void> { this.value = value; }
}

class FakeManager implements ServiceManager {
  definition: "missing" | "current" | "drifted";
  service: "stopped" | "running" | "failed";
  readonly calls: string[];

  constructor(
    calls: string[],
    definition: "missing" | "current" | "drifted" = "current",
    service: "stopped" | "running" | "failed" = "stopped",
  ) {
    this.calls = calls;
    this.definition = definition;
    this.service = service;
  }

  async inspect() {
    this.calls.push("inspect");
    return { definition: this.definition, service: this.service, diagnostics: "" };
  }
  async install(): Promise<void> {
    this.calls.push("install");
    this.definition = "current";
    this.service = "running";
  }
  async start(): Promise<void> { this.calls.push("start"); this.service = "running"; }
  async stop(): Promise<void> { this.calls.push("stop"); this.service = "stopped"; }
  async restart(): Promise<void> { this.calls.push("restart"); this.service = "running"; }
  async uninstall(): Promise<void> {
    this.calls.push("uninstall");
    this.definition = "missing";
    this.service = "stopped";
  }
}

async function fixture(options: {
  readonly autoStart?: boolean;
  readonly definition?: "missing" | "current" | "drifted";
  readonly service?: "stopped" | "running" | "failed";
} = {}) {
  const registry = new LocalProfileRegistry(new MemoryStore(), async () => [DEFAULT_LOCAL_PROFILE]);
  await registry.add({
    profileId: "fable-swarm",
    label: "Fable Swarm",
    autoStart: options.autoStart ?? false,
  });
  const calls: string[] = [];
  const manager = new FakeManager(
    calls,
    options.definition ?? "current",
    options.service ?? "stopped",
  );
  const runtime = new LocalProfileRuntime({
    registry,
    targets: {
      connect: async (targetId) => { calls.push(`connect:${targetId}`); return "connected"; },
      disconnect: async (targetId) => { calls.push(`disconnect:${targetId}`); },
    },
    acquireServiceManager: async () => manager,
  });
  return { calls, manager, registry, runtime };
}

describe("local profile runtime", () => {
  it("repairs a drifted service before starting and connects the matching target once", async () => {
    const { calls, runtime } = await fixture({ definition: "drifted" });
    const profile = await runtime.action("fable-swarm", "start");
    expect(calls).toEqual([
      "inspect",
      "install",
      "inspect",
      "connect:local:fable-swarm",
    ]);
    expect(profile.service).toMatchObject({ definition: "current", service: "running" });
  });

  it("restarts then reconnects, while stop disconnects before stopping", async () => {
    const { calls, manager, runtime } = await fixture({ service: "running" });
    await runtime.action("fable-swarm", "restart");
    expect(calls).toEqual([
      "inspect",
      "restart",
      "inspect",
      "connect:local:fable-swarm",
    ]);

    calls.length = 0;
    manager.definition = "missing";
    manager.service = "running";
    await runtime.action("fable-swarm", "stop");
    expect(calls).toEqual([
      "disconnect:local:fable-swarm",
      "inspect",
      "stop",
      "inspect",
    ]);
  });

  it("auto-starts only opted-in named profiles and never double-connects", async () => {
    const { calls, runtime } = await fixture({ autoStart: true });
    await runtime.startAutomaticProfiles();
    expect(calls).toEqual([
      "inspect",
      "start",
      "inspect",
      "connect:local:fable-swarm",
    ]);
  });

  it("removes named definitions but never permits removing default", async () => {
    const { calls, manager, registry, runtime } = await fixture({ service: "running" });
    await expect(runtime.remove("default")).rejects.toThrow("default profile is immutable");
    expect(calls).toEqual([]);

    manager.definition = "missing";
    await runtime.remove("fable-swarm");
    expect(calls).toEqual([
      "disconnect:local:fable-swarm",
      "inspect",
      "uninstall",
    ]);
    await expect(registry.get("fable-swarm")).rejects.toThrow("local profile not found");
  });
});
