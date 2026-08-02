import { describe, expect, test } from "bun:test";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  hostDaemonPaths,
  OFFICIAL_OMP_BUILD,
  OFFICIAL_OMP_VERSION,
  officialSettingsFromConfig,
  parseHostDaemonArgs,
  runHostDaemon,
  verifyOfficialRuntime,
  type OfficialSettingsEdit,
} from "../src/cli.ts";

describe("T4 host daemon CLI", () => {
  test("parses a local direct-replacement service without ambient executable lookup", () => {
    const config = parseHostDaemonArgs(
      ["serve", "--omp", "/opt/t4/runtime/omp", "--profile", "default"],
      "/home/test",
    );
    expect(config).toEqual({
      ompExecutable: "/opt/t4/runtime/omp",
      authorityMode: "bridge",
      profileId: "default",
      stateRoot: "/home/test/.t4-code/host",
    });
    expect(hostDaemonPaths(config)).toMatchObject({
      profileStateRoot: expect.stringContaining("/home/test/.t4-code/host/profiles/"),
      hostIdPath: expect.stringContaining("/host-id"),
      sessionOwnershipPath: expect.stringContaining("/owned-sessions.json"),
      transcriptSearchPath: expect.stringContaining("/transcript-search.sqlite"),
    });
  });

  test("validates remote exposure and rejects ambiguous or relative authority", () => {
    expect(() => parseHostDaemonArgs(["serve", "--omp", "omp"], "/home/test")).toThrow("absolute");
    expect(() =>
      parseHostDaemonArgs(
        ["serve", "--omp", "/opt/omp", "--remote-address", "100.64.0.1"],
        "/home/test",
      ),
    ).toThrow("require --remote-mode");
    expect(() =>
      parseHostDaemonArgs(
        ["serve", "--omp", "/opt/omp", "--remote-mode", "serve", "--remote-address", "0.0.0.0"],
        "/home/test",
      ),
    ).toThrow("loopback");
    expect(() =>
      parseHostDaemonArgs(
        [
          "serve",
          "--omp",
          "/opt/omp",
          "--remote-mode",
          "direct",
          "--remote-address",
          "100.64.0.1",
          "--remote-origin",
          "https://example.com/path",
        ],
        "/home/test",
      ),
    ).toThrow("HTTP origin");
    expect(() =>
      parseHostDaemonArgs(
        ["serve", "--omp", "/opt/omp", "--omp-authority", "official"],
        "/home/test",
      ),
    ).toThrow("--omp-sessions-root");
    expect(
      parseHostDaemonArgs(
        [
          "serve",
          "--omp",
          "/opt/omp",
          "--omp-authority",
          "official",
          "--omp-sessions-root",
          "/home/test/.omp/t4/sessions",
          "--profile",
          "t4",
        ],
        "/home/test",
      ),
    ).toMatchObject({
      authorityMode: "official",
      ompSessionsRoot: "/home/test/.omp/t4/sessions",
      profileId: "t4",
    });
  });

  test("stops the OMP bridge when authority startup fails", async () => {
    let bridgeStops = 0;
    const bridge = {
      start: async () => {},
      createAuthorities: () => ({ hostInfo: async () => { throw new Error("host info failed"); } }),
      stop: async () => { bridgeStops += 1; },
    };
    await expect(
      runHostDaemon(
        { ompExecutable: "/opt/omp", profileId: "test", stateRoot: "/tmp/t4-host-test" },
        { createBridge: () => bridge as never },
      ),
    ).rejects.toThrow("host info failed");
    expect(bridgeStops).toBe(1);
  });

  test("closes the search index when appserver construction fails", async () => {
    let bridgeStops = 0;
    let searchCloses = 0;
    const bridge = {
      start: async () => {},
      createAuthorities: () => ({
        hostInfo: async () => ({ transcriptImageRoot: "/tmp/images" }),
        sessionAuthority: {},
        discovery: {},
        operationsAuthority: {},
        projectRootForProject: async () => "/tmp",
        lockCheck: async () => {},
        lockStatus: async () => "missing",
      }),
      identity: { ompVersion: "17.0.5", ompBuild: "test" },
      stop: async () => { bridgeStops += 1; },
    };
    await expect(
      runHostDaemon(
        { ompExecutable: "/opt/omp", profileId: "test", stateRoot: "/tmp/t4-host-test" },
        {
          createBridge: () => bridge as never,
          createTranscriptSearch: () => ({ close: async () => { searchCloses += 1; } }) as never,
          createLocal: () => { throw new Error("appserver construction failed"); },
        },
      ),
    ).rejects.toThrow("appserver construction failed");
    expect(searchCloses).toBe(1);
    expect(bridgeStops).toBe(1);
  });
  test("uses explicit OMP bridge stdio argv and top-level session RPC argv", async () => {
    let bridgeStops = 0;
    let capturedInvocation: unknown;
    let capturedOptions: Record<string, unknown> | undefined;
    const bridge = {
      start: async () => {},
      createAuthorities: () => ({
        hostInfo: async () => ({ transcriptImageRoot: "/tmp/images" }),
        sessionAuthority: {},
        discovery: {},
        operationsAuthority: {},
        projectRootForProject: async () => "/tmp",
        projectRootForSession: async () => "/tmp",
        lockCheck: async () => {},
        lockStatus: async () => "missing",
      }),
      identity: { ompVersion: "17.0.5", ompBuild: "test" },
      stop: async () => { bridgeStops += 1; },
    };
    await expect(
      runHostDaemon(
        { ompExecutable: "/opt/omp", profileId: "test", stateRoot: "/tmp/t4-host-test" },
        {
          createBridge: (_config, invocation) => {
            capturedInvocation = invocation;
            return bridge as never;
          },
          createTranscriptSearch: () => ({ close: async () => {} }) as never,
          createLocal: (options: unknown) => {
            capturedOptions = options as Record<string, unknown>;
            throw new Error("captured appserver options");
          },
        },
      ),
    ).rejects.toThrow("captured appserver options");
    expect(capturedInvocation).toEqual({
      executable: "/opt/omp",
      argv: ["bridge", "--stdio"],
      environment: { OMP_PROFILE: "test" },
    });
    expect(capturedOptions?.rpcChildInvocation).toEqual({
      executable: "/opt/omp",
      prefixArgv: [],
    });
    expect(bridgeStops).toBe(1);
  });


  test("claims lockless sessions for local bridge hosts only", async () => {
    const captures: Record<string, unknown>[] = [];
    const bridge = {
      start: async () => {},
      createAuthorities: () => ({
        hostInfo: async () => ({}),
        sessionAuthority: {},
        discovery: {},
        operationsAuthority: {},
        projectRootForProject: async () => "/tmp",
        projectRootForSession: async () => "/tmp",
        lockCheck: async () => {},
        lockStatus: async () => "missing",
      }),
      identity: { ompVersion: "17.0.5", ompBuild: "test" },
      stop: async () => {},
    };
    const dependencies = {
      createBridge: () => bridge as never,
      createTranscriptSearch: () => ({ close: async () => {} }) as never,
      createLocal: (options: unknown) => {
        captures.push(options as unknown as Record<string, unknown>);
        throw new Error("captured bridge options");
      },
      createRemote: (options: { readonly appserver?: unknown }) => {
        captures.push(options.appserver as unknown as Record<string, unknown>);
        throw new Error("captured bridge options");
      },
    };
    await expect(
      runHostDaemon(
        { ompExecutable: "/opt/omp", profileId: "default", stateRoot: "/tmp/t4-local-bridge" },
        dependencies,
      ),
    ).rejects.toThrow("captured bridge options");
    await expect(
      runHostDaemon(
        {
          ompExecutable: "/opt/omp",
          profileId: "default",
          stateRoot: "/tmp/t4-remote-bridge",
          remote: { mode: "direct", address: "100.64.0.1", port: 8787, origins: [], trustedServeProxy: false },
        },
        dependencies,
      ),
    ).rejects.toThrow("captured bridge options");
    expect(captures[0]?.claimLocklessSessions).toBe(true);
    expect(captures[1]?.claimLocklessSessions).toBeUndefined();
  });

  test("stops the appserver and exits when the bridge dies after startup", async () => {
    const closeGate = Promise.withResolvers<Error>();
    let bridgeStops = 0;
    let appserverStarts = 0;
    let appserverStops = 0;
    const bridge = {
      start: async () => {},
      createAuthorities: () => ({
        hostInfo: async () => ({ transcriptImageRoot: "/tmp/images" }),
        sessionAuthority: {},
        discovery: {},
        operationsAuthority: {},
        projectRootForProject: async () => "/tmp",
        lockCheck: async () => {},
        lockStatus: async () => "missing",
      }),
      identity: { ompVersion: "17.0.5", ompBuild: "test" },
      stop: async () => { bridgeStops += 1; },
      closed: closeGate.promise,
    };
    const appserver = {
      start: async () => { appserverStarts += 1; },
      stop: async () => { appserverStops += 1; },
    };
    const run = runHostDaemon(
      { ompExecutable: "/opt/omp", profileId: "test", stateRoot: "/tmp/t4-host-test" },
      {
        createBridge: () => bridge as never,
        createTranscriptSearch: () => ({ close: async () => {} }) as never,
        createLocal: () => appserver as never,
        onSignal: () => {},
        removeSignal: () => {},
      },
    );
    closeGate.resolve(new Error("OMP authority bridge exited (1): boom"));
    await expect(run).rejects.toThrow("bridge exited (1): boom");
    expect(appserverStarts).toBe(1);
    expect(appserverStops).toBe(1);
    expect(bridgeStops).toBe(1);
  });

  test("pins and reports the exact official OMP runtime before exposing official authority", async () => {
    let authorityCloses = 0;
    let captured: Record<string, unknown> | undefined;
    const sessionModels = ["anthropic/claude-opus-4.5"];
    const authority = {
      initialize: async () => {},
      close: async () => { authorityCloses += 1; },
      projectRootForProject: async () => "/tmp",
      projectRootForSession: async () => "/tmp",
      lockCheck: async () => {},
      lockStatus: () => "missing",
      list: async () => sessionModels.map((model, index) => ({
        sessionId: `session-${index}`,
        path: `/tmp/session-${index}.jsonl`,
        cwd: "/tmp",
        projectId: "project-test",
        title: `Session ${index}`,
        updatedAt: "2026-08-01T00:00:00.000Z",
        status: "idle",
        model,
        entries: [],
      })),
    };
    await expect(
      runHostDaemon(
        {
          ompExecutable: "/opt/omp",
          authorityMode: "official",
          ompSessionsRoot: "/tmp/t4-official-sessions",
          profileId: "t4",
          stateRoot: "/tmp/t4-official-state",
        },
        {
          verifyOfficialRuntime: async () => ({
            ompVersion: OFFICIAL_OMP_VERSION,
            ompBuild: OFFICIAL_OMP_BUILD,
          }),
          listOfficialModelCatalogItems: async () => [
            {
              id: "model-openai-codex-gpt-5-5",
              kind: "model",
              name: "GPT-5.5",
              supported: true,
              metadata: { provider: "openai-codex", modelId: "gpt-5.5" },
            },
          ],
          listOfficialSettingsMetadata: async () => ({
            modelRoles: {
              controlType: "record",
              effective: { default: "openai-codex/gpt-5.5" },
              effectiveSource: "global",
              configured: true,
              sensitive: false,
              scopes: ["global", "session"],
              tab: "model",
            },
            "auth.broker.token": {
              controlType: "string",
              configured: true,
              sensitive: true,
              scopes: ["global"],
            },
          }),
          createOfficialAuthority: () => authority as never,
          createTranscriptSearch: () => ({ close: async () => {} }) as never,
          createLocal: (options: unknown) => {
            captured = options as unknown as Record<string, unknown>;
            throw new Error("captured official options");
          },
        },
      ),
    ).rejects.toThrow("captured official options");
    expect(captured).toMatchObject({
      ompVersion: OFFICIAL_OMP_VERSION,
      ompBuild: OFFICIAL_OMP_BUILD,
      rpcDialect: "official-17.2.4",
      claimLocklessSessions: true,
      sessionOwnershipPath: expect.stringContaining("/owned-sessions.json"),
    });
    const operations = captured?.operationsAuthority as {
      catalogGet?: () => Promise<Record<string, unknown>>;
      settingsRead?: () => Promise<Record<string, unknown>>;
    };
    expect(await operations.catalogGet?.()).toMatchObject({
      revision: expect.stringContaining(`official-omp-${OFFICIAL_OMP_VERSION}-official-settings-`),
    });
    const catalog = await operations.catalogGet?.();
    if (!catalog) throw new Error("official catalog missing");
    const officialItems = catalog.items as Array<{ kind: string; name: string; metadata?: Record<string, unknown> }>;
    const commandNames = officialItems.filter(item => item.kind === "command").map(item => item.name);
    const modelItems = officialItems.filter(item => item.kind === "model");
    const settingItems = officialItems.filter(item => item.kind === "setting");
    expect(settingItems).toContainEqual(
      expect.objectContaining({
        name: "modelRoles",
        metadata: expect.objectContaining({
          path: "modelRoles",
          controlType: "record",
          effective: { default: "openai-codex/gpt-5.5" },
        }),
      }),
    );
    expect(settingItems).toContainEqual(
      expect.objectContaining({
        name: "auth.broker.token",
        metadata: expect.objectContaining({
          path: "auth.broker.token",
          controlType: "string",
          sensitive: true,
        }),
      }),
    );
    expect(settingItems.find(item => item.name === "auth.broker.token")?.metadata).not.toHaveProperty("effective");
    expect(modelItems).toContainEqual(
      expect.objectContaining({
        name: "GPT-5.5",
        metadata: expect.objectContaining({ provider: "openai-codex", modelId: "gpt-5.5" }),
      }),
    );
    expect(modelItems).toContainEqual(
      expect.objectContaining({
        name: "anthropic/claude-opus-4.5",
        metadata: expect.objectContaining({
          provider: "anthropic",
          modelId: "claude-opus-4.5",
          selector: "anthropic/claude-opus-4.5",
        }),
      }),
    );
    sessionModels.push("google/gemini-3-pro");
    const refreshedCatalog = await operations.catalogGet?.();
    const refreshedItems = refreshedCatalog?.items as Array<{ kind: string; metadata?: Record<string, unknown> }> | undefined;
    expect(refreshedItems?.filter(item => item.kind === "model")).toContainEqual(
      expect.objectContaining({
        metadata: expect.objectContaining({ selector: "google/gemini-3-pro" }),
      }),
    );
    expect(commandNames).toContain("session.model.set");
    // Official OMP gained `set_fast_mode` in 17.2.0; retry stays fork-only.
    expect(commandNames).toContain("session.fast.set");
    expect(commandNames).not.toContain("session.retry");
    expect(commandNames).toContain("settings.read");
    const settings = await operations.settingsRead?.();
    expect(settings).toMatchObject({
      revision: expect.stringContaining("official-settings-"),
      settings: {
        modelRoles: expect.objectContaining({
          effective: { default: "openai-codex/gpt-5.5" },
          sensitive: false,
        }),
        "auth.broker.token": expect.objectContaining({
          configured: true,
          sensitive: true,
        }),
      },
    });
    const settingsFrame = settings?.settings as Record<string, Record<string, unknown>> | undefined;
    expect(settingsFrame?.["auth.broker.token"]).not.toHaveProperty("effective");
    // Presentation keys belong to the catalog item; the frame is values only.
    expect(settingsFrame?.modelRoles).not.toHaveProperty("tab");
    expect(settingsFrame?.modelRoles).not.toHaveProperty("path");
    expect(authorityCloses).toBe(1);
  });

  test("official runtime probe fails closed on version drift", async () => {
    const root = await mkdtemp(join(tmpdir(), "t4-official-version-"));
    const exact = join(root, "exact-omp");
    const drifted = join(root, "drifted-omp");
    await Promise.all([
      writeFile(exact, `#!/bin/sh\nprintf 'omp/${OFFICIAL_OMP_VERSION}\\n'\n`),
      writeFile(drifted, "#!/bin/sh\nprintf 'omp/17.0.7\\n'\n"),
    ]);
    await Promise.all([chmod(exact, 0o700), chmod(drifted, 0o700)]);
    expect(await verifyOfficialRuntime(exact)).toEqual({
      ompVersion: OFFICIAL_OMP_VERSION,
      ompBuild: OFFICIAL_OMP_BUILD,
    });
    await expect(verifyOfficialRuntime(drifted)).rejects.toThrow(`omp/${OFFICIAL_OMP_VERSION}`);
  });

  test("maps the official config schema onto wire settings with honest provenance", () => {
    const settings = officialSettingsFromConfig(
      {
        autoResume: { value: false, type: "boolean", description: "Resume the most recent session" },
        "theme.dark": { value: "titanium", type: "string", description: "" },
        "power.sleepPrevention": { value: "idle", type: "enum", description: "Prevent sleep" },
        modelRoles: { value: { smol: "anthropic/claude-haiku-4-5" }, type: "record", description: "" },
        "auth.broker.token": { type: "string", description: "" },
        // 17.2.x names the credential itself; this path defeats the name heuristic.
        "providers.exa.key": { redacted: true, type: "string", description: "" },
        "dev.autoqaPush.enabled": { value: "plain", type: "string", description: "" },
        // A numeric limit whose name merely contains "tokens" is not a secret.
        "commit.mapReduceMaxFileTokens": { value: 24000, type: "number", description: "" },
      },
      { theme: { dark: "titanium" }, modelRoles: { smol: "anthropic/claude-haiku-4-5" } },
    ) as Record<string, Record<string, unknown>>;

    // Present in the global document -> a real global override.
    expect(settings["theme.dark"]).toMatchObject({
      controlType: "string",
      configured: true,
      effective: "titanium",
      effectiveSource: "global",
      tab: "appearance",
    });
    expect(settings["theme.dark"]).not.toHaveProperty("default");
    // Absent from the global document -> the runtime value IS the default.
    expect(settings.autoResume).toMatchObject({
      controlType: "boolean",
      configured: false,
      default: false,
      tab: "general",
    });
    expect(settings.autoResume).not.toHaveProperty("effective");
    // OMP publishes no enum options, so an enum degrades to free text.
    expect(settings["power.sleepPrevention"]).toMatchObject({
      controlType: "string",
      configured: false,
      // No curated home for this prefix: Advanced, grouped by the raw prefix,
      // so an unbounded schema can never outgrow the renderer's section cap.
      tab: "advanced",
      group: "power",
    });
    expect(settings.modelRoles).toMatchObject({
      controlType: "record",
      configured: true,
      effective: { smol: "anthropic/claude-haiku-4-5" },
      tab: "model",
    });
    // Secret-like paths and values with secret-like nested keys never carry values.
    expect(settings["auth.broker.token"]).toMatchObject({ sensitive: true, configured: false });
    expect(settings["auth.broker.token"]).not.toHaveProperty("effective");
    expect(settings["providers.headers"]).not.toHaveProperty("effective");
    expect(settings["providers.headers"]).not.toHaveProperty("default");
    // The runtime's own `redacted` verdict wins where the name heuristic is blind.
    expect(settings["providers.exa.key"]).toMatchObject({ sensitive: true });
    expect(settings["providers.exa.key"]).not.toHaveProperty("default");
    expect(settings["dev.autoqaPush.enabled"]).toMatchObject({ sensitive: false, default: "plain" });
    expect(settings["commit.mapReduceMaxFileTokens"]).toMatchObject({ sensitive: false, default: 24000 });
    // Only the machine-wide layer is writable through this authority.
    for (const row of Object.values(settings)) expect(row.scopes).toEqual(["global"]);
  });

  test("writes official settings through the runtime and republishes a fresh revision", async () => {
    let captured: Record<string, unknown> | undefined;
    const applied: OfficialSettingsEdit[][] = [];
    const schema: Record<string, Record<string, unknown>> = {
      autoResume: { controlType: "boolean", configured: false, sensitive: false, scopes: ["global"], default: false },
      "auth.broker.token": { controlType: "string", configured: false, sensitive: true, scopes: ["global"] },
    };
    const authority = {
      initialize: async () => {},
      close: async () => {},
      projectRootForProject: async () => "/tmp",
      projectRootForSession: async () => "/tmp",
      lockCheck: async () => {},
      lockStatus: () => "missing",
      list: async () => [],
    };
    await expect(
      runHostDaemon(
        {
          ompExecutable: "/opt/omp",
          authorityMode: "official",
          ompSessionsRoot: "/tmp/t4-official-sessions",
          profileId: "t4",
          stateRoot: "/tmp/t4-official-state",
        },
        {
          verifyOfficialRuntime: async () => ({ ompVersion: OFFICIAL_OMP_VERSION, ompBuild: OFFICIAL_OMP_BUILD }),
          listOfficialModelCatalogItems: async () => [],
          listOfficialSettingsMetadata: async () => structuredClone(schema),
          applyOfficialSettingsEdits: async (_config, edits) => {
            applied.push([...edits]);
            schema.autoResume = {
              controlType: "boolean",
              configured: true,
              sensitive: false,
              scopes: ["global"],
              effective: true,
              effectiveSource: "global",
            };
          },
          createOfficialAuthority: () => authority as never,
          createTranscriptSearch: () => ({ close: async () => {} }) as never,
          createLocal: (options: unknown) => {
            captured = options as Record<string, unknown>;
            throw new Error("captured official options");
          },
        },
      ),
    ).rejects.toThrow("captured official options");
    const operations = captured?.operationsAuthority as {
      settingsRead?: () => Promise<Record<string, unknown>>;
      settingsWrite?: (args: unknown, context: unknown) => Promise<Record<string, unknown>>;
    };
    const before = await operations.settingsRead?.();
    const revision = String(before?.revision);
    const context = { expectedRevision: revision };

    await expect(
      operations.settingsWrite?.({ edits: [{ path: "autoResume", scope: "session", value: true }] }, context),
    ).rejects.toThrow("whole machine");
    await expect(
      operations.settingsWrite?.({ edits: [{ path: "auth.broker.token", scope: "global", value: "nope" }] }, context),
    ).rejects.toThrow("secret settings");
    await expect(
      operations.settingsWrite?.({ edits: [{ path: "nope.missing", scope: "global", value: 1 }] }, context),
    ).rejects.toThrow("unknown setting path");
    await expect(
      operations.settingsWrite?.({ edits: [{ path: "autoResume", scope: "global", value: true }] }, {
        expectedRevision: "official-settings-stale",
      }),
    ).rejects.toThrow("stale");
    expect(applied).toEqual([]);

    const written = await operations.settingsWrite?.(
      { edits: [{ path: "autoResume", scope: "global", value: true }] },
      context,
    );
    expect(applied).toEqual([[{ path: "autoResume", scope: "global", value: true }]]);
    expect(String(written?.revision)).not.toBe(revision);
    const after = await operations.settingsRead?.();
    expect(after?.revision).toBe(written?.revision);
    const settingsAfter = after?.settings as Record<string, Record<string, unknown>> | undefined;
    expect(settingsAfter?.autoResume).toMatchObject({
      configured: true,
      effective: true,
    });
  });
});
