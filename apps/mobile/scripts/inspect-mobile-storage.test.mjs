import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import {
  APPROVED_MOBILE_STORAGE_KEY,
  LEGACY_MOBILE_STORAGE_KEY,
  evaluateCdp,
  inspectMobileStorage,
  parseStorageInspectorArguments,
  summarizeStoredConnection,
} from "./inspect-mobile-storage.mjs";

const PUBLIC_KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const invite = `t4peer://v1/${PUBLIC_KEY}/BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBA`;
const HOST_ID = "host_AAAAAAAAAAA";
const TAILSCALE_ID = "tail_AAAAAAAAAAA";
const HYPERDHT_ID = "peer_AAAAAAAAAAA";

function validV3() {
  return {
    version: 3,
    activeHostId: HOST_ID,
    hosts: [{
      id: HOST_ID,
      label: "Private desktop label",
      transports: [
        {
          id: TAILSCALE_ID,
          kind: "tailscale",
          origin: "https://desk.tailnet.ts.net:8445",
          wsUrl: "wss://desk.tailnet.ts.net:8445/v1/ws",
          displayAddress: "https://desk.tailnet.ts.net:8445",
          credentialScopeKey: "https://desk.tailnet.ts.net:8445",
        },
        { id: HYPERDHT_ID, kind: "hyperdht", invite, desktopFingerprint: "AAAAAAAA" },
      ],
      preferredTransportIds: [HYPERDHT_ID, TAILSCALE_ID],
      lastConnection: { kind: "hyperdht", at: 42, outcome: "connected" },
    }],
  };
}

test("summarizes a valid v3 directory with the exact bounded shape", () => {
  const summary = summarizeStoredConnection(JSON.stringify(validV3()));
  assert.deepEqual(summary, {
    present: true,
    version: 3,
    activeHost: true,
    hostCount: 1,
    transportKinds: ["hyperdht", "tailscale"],
  });
  const output = JSON.stringify(summary);
  for (const forbidden of [HOST_ID, TAILSCALE_ID, HYPERDHT_ID, invite, PUBLIC_KEY, "desk.tailnet", "Private desktop label", "AAAAAAAA"]) {
    assert.equal(output.includes(forbidden), false);
  }
});

test("summarizes v3 absence with the exact bounded field set", () => {
  assert.deepEqual(summarizeStoredConnection(null), {
    present: false,
    version: null,
    activeHost: false,
    hostCount: 0,
    transportKinds: [],
  });
});

test("rejects an invalid v3 active-host reference", () => {
  assert.throws(
    () => summarizeStoredConnection(JSON.stringify({ ...validV3(), activeHostId: "host_BBBBBBBBBBB" })),
    /mobile storage inspection failed/,
  );
});

for (const mutate of [
  (value) => ({ ...value, credential: "private" }),
  (value) => ({ ...value, hosts: [{ ...value.hosts[0], extra: true }] }),
  (value) => ({ ...value, hosts: [{ ...value.hosts[0], transports: [{ ...value.hosts[0].transports[0], secret: true }] }] }),
  (value) => ({ ...value, hosts: [{ ...value.hosts[0], preferredTransportIds: [TAILSCALE_ID] }] }),
]) {
  test("rejects forbidden or inconsistent v3 shapes without echoing bytes", () => {
    assert.throws(() => summarizeStoredConnection(JSON.stringify(mutate(validV3()))), /mobile storage inspection failed/);
  });
}

test("retains bounded v2 peer compatibility without returning values", () => {
  const summary = summarizeStoredConnection(JSON.stringify({ version: 2, kind: "peer", invite, label: "private label" }));
  assert.deepEqual(summary, {
    present: true,
    version: 2,
    kind: "peer",
    fieldNames: ["invite", "kind", "label", "version"],
    inviteLength: invite.length,
  });
  assert.doesNotMatch(JSON.stringify(summary), /t4peer|private label/);
});

for (const raw of ["{", "[]", JSON.stringify({ version: 99 }), JSON.stringify({ version: 2, kind: "peer", invite: 3, label: "x" })]) {
  test("rejects unexpected mobile storage shape without echoing bytes", () => {
    let error;
    try { summarizeStoredConnection(raw); } catch (caught) { error = caught; }
    assert.match(error?.message ?? "", /mobile storage inspection failed/);
    assert.equal((error?.message ?? "").includes(raw), false);
  });
}

test("forwards one WebView socket, evaluates exactly the approved key, and removes the forward", async () => {
  const adbCalls = [];
  const evaluations = [];
  const summary = await inspectMobileStorage({
    key: APPROVED_MOBILE_STORAGE_KEY,
    runAdb: async (args) => {
      adbCalls.push(args);
      if (args[0] === "shell") return { status: 0, stdout: "4321\n", stderr: "", truncated: false };
      if (args[0] === "forward" && args[1] === "tcp:0") return { status: 0, stdout: "59321\n", stderr: "", truncated: false };
      return { status: 0, stdout: "removed\n", stderr: "", truncated: false };
    },
    fetchTargets: async (url) => {
      assert.equal(url, "http://127.0.0.1:59321/json");
      return JSON.stringify([{ type: "page", webSocketDebuggerUrl: "ws://127.0.0.1:59321/devtools/page/1" }]);
    },
    evaluate: async (url, expression) => {
      evaluations.push([url, expression]);
      return JSON.stringify({ id: 1, result: { result: { type: "string", value: JSON.stringify({ version: 2, kind: "peer", invite, label: "hidden" }) } } });
    },
  });

  assert.equal(summary.inviteLength, invite.length);
  assert.deepEqual(evaluations, [[
    "ws://127.0.0.1:59321/devtools/page/1",
    `localStorage.getItem(${JSON.stringify(APPROVED_MOBILE_STORAGE_KEY)})`,
  ]]);
  assert.deepEqual(adbCalls, [
    ["shell", "pidof", "com.lycaonsolutions.t4code"],
    ["forward", "tcp:0", "localabstract:webview_devtools_remote_4321"],
    ["forward", "--remove", "tcp:59321"],
  ]);
});

test("removes the forwarding rule when inspection fails", async () => {
  const calls = [];
  await assert.rejects(() => inspectMobileStorage({
    runAdb: async (args) => {
      calls.push(args);
      if (args[0] === "shell") return { status: 0, stdout: "4321", stderr: "", truncated: false };
      if (args[1] === "tcp:0") return { status: 0, stdout: "59321", stderr: "", truncated: false };
      return { status: 0, stdout: "ok", stderr: "", truncated: false };
    },
    fetchTargets: async () => "[]",
    evaluate: async () => { throw new Error("should not run"); },
  }), /mobile storage inspection failed/);
  assert.deepEqual(calls.at(-1), ["forward", "--remove", "tcp:59321"]);
});

async function captureInspectionError(operation) {
  try {
    await operation();
  } catch (error) {
    return error;
  }
  assert.fail("expected mobile storage inspection to fail");
}

for (const stage of ["pidof", "forward"]) {
  test(`normalizes an injected ${stage} ADB throw without leaking its message`, async () => {
    const secret = `/private/${stage}-secret-token`;
    const error = await captureInspectionError(() => inspectMobileStorage({
      runAdb: async (args) => {
        if (stage === "pidof" || args[0] === "forward") throw new Error(secret);
        return { status: 0, stdout: "4321", stderr: "", truncated: false };
      },
    }));
    assert.equal(error.message, "mobile storage inspection failed");
    assert.doesNotMatch(error.message, /private|secret|token/);
  });
}

test("attempts allocated-forward cleanup and normalizes a cleanup throw", async () => {
  const calls = [];
  const error = await captureInspectionError(() => inspectMobileStorage({
    runAdb: async (args) => {
      calls.push(args);
      if (args[0] === "shell") return { status: 0, stdout: "4321", stderr: "", truncated: false };
      if (args[1] === "tcp:0") return { status: 0, stdout: "59321", stderr: "", truncated: false };
      throw new Error("/private/remove-forward-secret");
    },
    fetchTargets: async () => { throw new Error("/private/page-secret"); },
  }));
  assert.deepEqual(calls.at(-1), ["forward", "--remove", "tcp:59321"]);
  assert.equal(error.message, "mobile storage inspection failed");
  assert.doesNotMatch(error.message, /private|secret/);
});

test("accepts only production v3 and legacy v2 storage keys", async () => {
  await assert.rejects(
    () => inspectMobileStorage({ key: "other", runAdb: async () => { throw new Error("must not run"); } }),
    /mobile storage inspection failed/,
  );
  assert.equal(LEGACY_MOBILE_STORAGE_KEY, "t4-code:mobile-backends:v2");
});

test("accepts only bounded production storage inspector CLI arguments", () => {
  assert.deepEqual(parseStorageInspectorArguments([
    "--serial", "emulator-5554",
    "--package", "com.lycaonsolutions.t4code",
    "--key", APPROVED_MOBILE_STORAGE_KEY,
  ]), {
    serial: "emulator-5554",
    applicationId: "com.lycaonsolutions.t4code",
    key: APPROVED_MOBILE_STORAGE_KEY,
  });
  for (const args of [
    ["--serial", "emulator-5554;private"],
    ["--package", "other.package"],
    ["--key", "other"],
    ["--unknown", "value"],
  ]) assert.throws(() => parseStorageInspectorArguments(args), /mobile storage inspection failed/);
});

test("uses the explicitly approved legacy v2 key for compatibility inspection", async () => {
  const evaluations = [];
  const summary = await inspectMobileStorage({
    key: LEGACY_MOBILE_STORAGE_KEY,
    runAdb: async (args) => {
      if (args[0] === "shell") return { status: 0, stdout: "4321", stderr: "", truncated: false };
      if (args[1] === "tcp:0") return { status: 0, stdout: "59321", stderr: "", truncated: false };
      return { status: 0, stdout: "", stderr: "", truncated: false };
    },
    fetchTargets: async () => JSON.stringify([{ type: "page", webSocketDebuggerUrl: "ws://127.0.0.1:59321/devtools/page/1" }]),
    evaluate: async (_url, expression) => {
      evaluations.push(expression);
      return JSON.stringify({ id: 1, result: { result: { type: "string", value: JSON.stringify({ version: 2, kind: "peer", invite, label: "hidden" }) } } });
    },
  });
  assert.equal(summary.version, 2);
  assert.deepEqual(evaluations, [`localStorage.getItem(${JSON.stringify(LEGACY_MOBILE_STORAGE_KEY)})`]);
});

test("scopes every ADB command to the approved serial when provided", async () => {
  const calls = [];
  await inspectMobileStorage({
    serial: "emulator-5554",
    runAdb: async (args) => {
      calls.push(args);
      if (args[2] === "shell") return { status: 0, stdout: "4321", stderr: "", truncated: false };
      if (args[3] === "tcp:0") return { status: 0, stdout: "59321", stderr: "", truncated: false };
      return { status: 0, stdout: "", stderr: "", truncated: false };
    },
    fetchTargets: async () => JSON.stringify([{ type: "page", webSocketDebuggerUrl: "ws://127.0.0.1:59321/devtools/page/1" }]),
    evaluate: async () => JSON.stringify({ id: 1, result: { result: { type: "object", subtype: "null", value: null } } }),
  });
  assert.deepEqual(calls, [
    ["-s", "emulator-5554", "shell", "pidof", "com.lycaonsolutions.t4code"],
    ["-s", "emulator-5554", "forward", "tcp:0", "localabstract:webview_devtools_remote_4321"],
    ["-s", "emulator-5554", "forward", "--remove", "tcp:59321"],
  ]);
});

for (const scenario of ["process", "forward", "page", "cdp", "truncated"]) {
  test(`fails closed when ${scenario} evidence is unavailable`, async () => {
    const runAdb = async (args) => {
      if (args[0] === "shell") return scenario === "process"
        ? { status: 1, stdout: "", stderr: "private", truncated: false }
        : { status: 0, stdout: "4321", stderr: "", truncated: false };
      if (args[1] === "tcp:0") return scenario === "forward"
        ? { status: 1, stdout: "", stderr: "private", truncated: false }
        : { status: 0, stdout: "59321", stderr: "", truncated: false };
      return { status: 0, stdout: "ok", stderr: "", truncated: false };
    };
    await assert.rejects(() => inspectMobileStorage({
      runAdb,
      fetchTargets: async () => scenario === "page" ? "[]" : JSON.stringify([{ type: "page", webSocketDebuggerUrl: "ws://127.0.0.1:59321/devtools/page/1" }]),
      evaluate: async () => scenario === "cdp" ? "{}" : scenario === "truncated" ? "x".repeat(70_000) : JSON.stringify({ id: 1, result: { result: { type: "object", subtype: "null", value: null } } }),
    }), /mobile storage inspection failed/);
  });
}

test("the CDP client rejects a silent socket within its bound", async () => {
  class SilentSocket extends EventEmitter {
    constructor() {
      super();
      queueMicrotask(() => this.emit("open"));
    }
    send() {}
    close() { this.emit("close"); }
    terminate() { this.emit("close"); }
  }

  await assert.rejects(
    () => evaluateCdp("ws://127.0.0.1:59321/devtools/page/1", "localStorage.getItem(\"approved\")", {
      WebSocketImpl: SilentSocket,
      timeoutMs: 1,
    }),
    /CDP evaluation unavailable/,
  );
});

test("bounds an injected ADB runner that never settles", async () => {
  const started = Date.now();
  const error = await captureInspectionError(() => inspectMobileStorage({
    adbTimeoutMs: 5,
    runAdb: async () => new Promise(() => {}),
  }));
  assert.equal(error.message, "mobile storage inspection failed");
  assert.ok(Date.now() - started < 1_000);
});

test("rejects a CDP page outside the allocated loopback port and still cleans up", async () => {
  const calls = [];
  const error = await captureInspectionError(() => inspectMobileStorage({
    runAdb: async (args) => {
      calls.push(args);
      if (args[0] === "shell") return { status: 0, stdout: "4321", stderr: "", truncated: false };
      if (args[1] === "tcp:0") return { status: 0, stdout: "59321", stderr: "", truncated: false };
      return { status: 0, stdout: "", stderr: "", truncated: false };
    },
    fetchTargets: async () => JSON.stringify([{
      type: "page",
      webSocketDebuggerUrl: "ws://attacker.example:59321/devtools/page/1",
    }]),
  }));
  assert.equal(error.message, "mobile storage inspection failed");
  assert.deepEqual(calls.at(-1), ["forward", "--remove", "tcp:59321"]);
});

test("rejects a loopback CDP page using a different forwarded port", async () => {
  const error = await captureInspectionError(() => inspectMobileStorage({
    runAdb: async (args) => {
      if (args[0] === "shell") return { status: 0, stdout: "4321", stderr: "", truncated: false };
      if (args[1] === "tcp:0") return { status: 0, stdout: "59321", stderr: "", truncated: false };
      return { status: 0, stdout: "", stderr: "", truncated: false };
    },
    fetchTargets: async () => JSON.stringify([{
      type: "page",
      webSocketDebuggerUrl: "ws://127.0.0.1:1/devtools/page/1",
    }]),
  }));
  assert.equal(error.message, "mobile storage inspection failed");
});

test("CDP evaluation ignores unsolicited frames and resolves only matching id 1", async () => {
  class EventThenResultSocket extends EventEmitter {
    constructor() {
      super();
      queueMicrotask(() => this.emit("open"));
    }
    send(_payload, callback) {
      callback?.();
      queueMicrotask(() => {
        this.emit("message", Buffer.from(JSON.stringify({ method: "Runtime.consoleAPICalled" })));
        this.emit("message", Buffer.from(JSON.stringify({ id: 2, result: {} })));
        this.emit("message", Buffer.from(JSON.stringify({ id: 1, result: { result: { value: null } } })));
      });
    }
    close() { this.emit("close"); }
    terminate() { this.emit("close"); }
  }

  const response = await evaluateCdp(
    "ws://127.0.0.1:59321/devtools/page/1",
    "localStorage.getItem(\"approved\")",
    { WebSocketImpl: EventThenResultSocket, timeoutMs: 50 },
  );
  assert.deepEqual(JSON.parse(response), { id: 1, result: { result: { value: null } } });
});

test("CDP evaluation rejects matching protocol errors without leaking details", async () => {
  class ProtocolErrorSocket extends EventEmitter {
    constructor() { super(); queueMicrotask(() => this.emit("open")); }
    send(_payload, callback) {
      callback?.();
      queueMicrotask(() => this.emit("message", Buffer.from(JSON.stringify({
        id: 1,
        error: { message: "/private/cdp-secret" },
      }))));
    }
    close() { this.emit("close"); }
    terminate() { this.emit("close"); }
  }
  const error = await captureInspectionError(() => evaluateCdp(
    "ws://127.0.0.1:59321/devtools/page/1",
    "expression",
    { WebSocketImpl: ProtocolErrorSocket, timeoutMs: 50 },
  ));
  assert.equal(error.message, "CDP evaluation unavailable");
  assert.doesNotMatch(error.message, /private|secret/);
});

for (const failure of ["constructor", "throw", "callback"]) {
  test(`CDP evaluation normalizes synchronous ${failure} failure`, async () => {
    class SendFailureSocket extends EventEmitter {
      constructor() {
        super();
        if (failure === "constructor") throw new Error("/private/constructor-secret");
        queueMicrotask(() => this.emit("open"));
      }
      send(_payload, callback) {
        if (failure === "throw") throw new Error("/private/send-secret");
        callback(new Error("/private/callback-secret"));
      }
      close() { this.emit("close"); }
      terminate() { this.emit("close"); }
    }
    const error = await captureInspectionError(() => evaluateCdp(
      "ws://127.0.0.1:59321/devtools/page/1",
      "expression",
      { WebSocketImpl: SendFailureSocket, timeoutMs: 50 },
    ));
    assert.equal(error.message, "CDP evaluation unavailable");
    assert.doesNotMatch(error.message, /private|secret/);
  });
}
