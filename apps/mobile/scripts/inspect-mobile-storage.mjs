import { execFile } from "node:child_process";
import { request } from "node:http";
import { resolve } from "node:path";
import { promisify } from "node:util";
import WebSocket from "ws";

const execFileAsync = promisify(execFile);
export const APPROVED_MOBILE_STORAGE_KEY = "t4-code:mobile-backends:v2";
const APPLICATION_ID = "com.lycaonsolutions.t4code";
const MAX_PROTOCOL_BYTES = 64 * 1024;
const CDP_TIMEOUT_MS = 5_000;
const ADB_TIMEOUT_MS = 5_000;

function fail() {
  throw new Error("mobile storage inspection failed");
}

export function parseStorageInspectorArguments(args) {
  if (!Array.isArray(args) || args.length % 2 !== 0) fail();
  const result = {
    serial: null,
    applicationId: APPLICATION_ID,
    key: APPROVED_MOBILE_STORAGE_KEY,
  };
  const seen = new Set();
  for (let index = 0; index < args.length; index += 2) {
    const option = args[index];
    const value = args[index + 1];
    if (seen.has(option) || typeof value !== "string") fail();
    seen.add(option);
    if (option === "--serial") {
      if (!/^[A-Za-z0-9._:-]{1,128}$/u.test(value)) fail();
      result.serial = value;
    } else if (option === "--package") {
      if (value !== APPLICATION_ID) fail();
      result.applicationId = value;
    } else if (option === "--key") {
      if (value !== APPROVED_MOBILE_STORAGE_KEY) fail();
      result.key = value;
    } else {
      fail();
    }
  }
  return result;
}

function exactFields(value, expected) {
  const actual = Object.keys(value).sort();
  return actual.length === expected.length && actual.every((name, index) => name === expected[index]);
}

function plainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validTailnetBackend(value) {
  return plainObject(value) && exactFields(value, ["label", "origin", "version", "wsUrl"]) &&
    value.version === 1 && typeof value.origin === "string" && typeof value.wsUrl === "string" &&
    typeof value.label === "string";
}

export function summarizeStoredConnection(rawValue) {
  if (rawValue === null) {
    return { present: false, version: null, kind: null, fieldNames: [], inviteLength: null };
  }
  if (typeof rawValue !== "string" || rawValue.length === 0 || rawValue.length > MAX_PROTOCOL_BYTES) fail();
  let value;
  try {
    value = JSON.parse(rawValue);
  } catch {
    fail();
  }
  if (!plainObject(value)) fail();
  const fieldNames = Object.keys(value).sort();
  if (
    exactFields(value, ["invite", "kind", "label", "version"]) && value.version === 2 &&
    value.kind === "peer" && typeof value.invite === "string" && value.invite.length <= 2048 &&
    typeof value.label === "string"
  ) {
    return { present: true, version: 2, kind: "peer", fieldNames, inviteLength: value.invite.length };
  }
  if (
    exactFields(value, ["activeOrigin", "backends", "version"]) && value.version === 2 &&
    typeof value.activeOrigin === "string" && Array.isArray(value.backends) &&
    value.backends.length > 0 && value.backends.length <= 16 && value.backends.every(validTailnetBackend)
  ) {
    return { present: true, version: 2, kind: "tailnet", fieldNames, inviteLength: null };
  }
  fail();
}

async function defaultRunAdb(args) {
  try {
    const result = await execFileAsync("adb", args, {
      encoding: "utf8",
      maxBuffer: MAX_PROTOCOL_BYTES,
      timeout: ADB_TIMEOUT_MS,
    });
    return { status: 0, stdout: result.stdout, stderr: result.stderr, truncated: false };
  } catch {
    return { status: 1, stdout: "", stderr: "", truncated: false };
  }
}

function checkedOutput(result) {
  if (
    !plainObject(result) || result.status !== 0 || result.truncated !== false ||
    typeof result.stdout !== "string" || result.stdout.trim().length === 0 || result.stdout.length > MAX_PROTOCOL_BYTES
  ) fail();
  return result.stdout.trim();
}

function withDeadline(operation, timeoutMs) {
  let timer;
  return Promise.race([
    Promise.resolve().then(operation),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("deadline exceeded")), timeoutMs);
    }),
  ]).finally(() => clearTimeout(timer));
}

async function runAdbStructural(runAdb, args, timeoutMs) {
  try {
    return await withDeadline(() => runAdb(args), timeoutMs);
  } catch {
    fail();
  }
}

function defaultFetchTargets(url) {
  return new Promise((resolveRequest, reject) => {
    const operation = request(url, { method: "GET", timeout: CDP_TIMEOUT_MS }, (response) => {
      if (response.statusCode !== 200) {
        response.resume();
        reject(new Error("target list unavailable"));
        return;
      }
      const chunks = [];
      let total = 0;
      response.on("data", (chunk) => {
        total += chunk.length;
        if (total > MAX_PROTOCOL_BYTES) {
          operation.destroy(new Error("target list too large"));
          return;
        }
        chunks.push(chunk);
      });
      response.on("end", () => resolveRequest(Buffer.concat(chunks).toString("utf8")));
    });
    operation.on("timeout", () => operation.destroy(new Error("target list timeout")));
    operation.on("error", reject);
    operation.end();
  });
}

export function evaluateCdp(webSocketUrl, expression, {
  WebSocketImpl = WebSocket,
  timeoutMs = CDP_TIMEOUT_MS,
} = {}) {
  return new Promise((resolveEvaluation, reject) => {
    let socket;
    try {
      socket = new WebSocketImpl(webSocketUrl, {
        maxPayload: MAX_PROTOCOL_BYTES,
        handshakeTimeout: timeoutMs,
      });
    } catch {
      reject(new Error("CDP evaluation unavailable"));
      return;
    }
    let settled = false;
    let receivedBytes = 0;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { socket.close(); } catch {}
      callback(value);
    };
    const timer = setTimeout(() => {
      finish(reject, new Error("CDP evaluation unavailable"));
      try { socket.terminate(); } catch {}
    }, timeoutMs);
    socket.once("open", () => {
      try {
        socket.send(JSON.stringify({
          id: 1,
          method: "Runtime.evaluate",
          params: { expression, returnByValue: true, awaitPromise: false },
        }), (error) => {
          if (error) finish(reject, new Error("CDP evaluation unavailable"));
        });
      } catch {
        finish(reject, new Error("CDP evaluation unavailable"));
      }
    });
    socket.on("message", (data) => {
      receivedBytes += data.length;
      if (receivedBytes > MAX_PROTOCOL_BYTES) {
        finish(reject, new Error("CDP evaluation unavailable"));
        return;
      }
      const raw = data.toString();
      let response;
      try { response = JSON.parse(raw); } catch {
        finish(reject, new Error("CDP evaluation unavailable"));
        return;
      }
      if (response?.id !== 1) return;
      if (response.error !== undefined || response.result === undefined) {
        finish(reject, new Error("CDP evaluation unavailable"));
        return;
      }
      finish(resolveEvaluation, raw);
    });
    socket.once("error", () => finish(reject, new Error("CDP evaluation unavailable")));
    socket.once("close", () => {
      if (!settled) finish(reject, new Error("CDP evaluation unavailable"));
    });
  });
}

function parseTargets(raw, expectedPort) {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > MAX_PROTOCOL_BYTES) fail();
  let targets;
  try { targets = JSON.parse(raw); } catch { fail(); }
  if (!Array.isArray(targets)) fail();
  const pages = targets.filter((target) =>
    plainObject(target) && target.type === "page" && typeof target.webSocketDebuggerUrl === "string"
  );
  if (pages.length !== 1) fail();
  let parsed;
  try { parsed = new URL(pages[0].webSocketDebuggerUrl); } catch { fail(); }
  if (
    parsed.protocol !== "ws:" || !["127.0.0.1", "localhost"].includes(parsed.hostname) ||
    parsed.port !== expectedPort || parsed.username !== "" || parsed.password !== "" ||
    !parsed.pathname.startsWith("/devtools/") || parsed.hash !== ""
  ) fail();
  return parsed.toString();
}

function parseEvaluation(raw) {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > MAX_PROTOCOL_BYTES) fail();
  let response;
  try { response = JSON.parse(raw); } catch { fail(); }
  const result = response?.id === 1 ? response?.result?.result : null;
  if (!plainObject(result)) fail();
  if (result.subtype === "null" && (result.value === null || result.value === undefined)) return null;
  if (result.type !== "string" || typeof result.value !== "string") fail();
  return result.value;
}

export async function inspectMobileStorage({
  key = APPROVED_MOBILE_STORAGE_KEY,
  serial = null,
  applicationId = APPLICATION_ID,
  runAdb = defaultRunAdb,
  adbTimeoutMs = ADB_TIMEOUT_MS,
  fetchTargets = defaultFetchTargets,
  evaluate = evaluateCdp,
} = {}) {
  if (
    key !== APPROVED_MOBILE_STORAGE_KEY || applicationId !== APPLICATION_ID ||
    !Number.isInteger(adbTimeoutMs) || adbTimeoutMs < 1 || adbTimeoutMs > ADB_TIMEOUT_MS
  ) fail();
  if (serial !== null && !/^[A-Za-z0-9._:-]{1,128}$/u.test(serial)) fail();
  const adbArgs = (args) => serial === null ? args : ["-s", serial, ...args];
  let port = null;
  try {
    const pid = checkedOutput(await runAdbStructural(
      runAdb,
      adbArgs(["shell", "pidof", applicationId]),
      adbTimeoutMs,
    ));
    if (!/^\d+$/u.test(pid)) fail();
    port = checkedOutput(await runAdbStructural(
      runAdb,
      adbArgs(["forward", "tcp:0", `localabstract:webview_devtools_remote_${pid}`]),
      adbTimeoutMs,
    ));
    if (!/^\d{1,5}$/u.test(port) || Number(port) < 1 || Number(port) > 65535) fail();
    let targetBytes;
    try {
      targetBytes = await withDeadline(
        () => fetchTargets(`http://127.0.0.1:${port}/json`),
        CDP_TIMEOUT_MS,
      );
    } catch { fail(); }
    const webSocketUrl = parseTargets(targetBytes, port);
    const expression = `localStorage.getItem(${JSON.stringify(APPROVED_MOBILE_STORAGE_KEY)})`;
    let evaluationBytes;
    try {
      evaluationBytes = await withDeadline(
        () => evaluate(webSocketUrl, expression),
        CDP_TIMEOUT_MS,
      );
    } catch { fail(); }
    return summarizeStoredConnection(parseEvaluation(evaluationBytes));
  } finally {
    if (port !== null) {
      const removed = await runAdbStructural(
        runAdb,
        adbArgs(["forward", "--remove", `tcp:${port}`]),
        adbTimeoutMs,
      );
      if (!plainObject(removed) || removed.status !== 0 || removed.truncated !== false) fail();
    }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  try {
    const options = parseStorageInspectorArguments(process.argv.slice(2));
    console.log(JSON.stringify(await inspectMobileStorage(options)));
  } catch {
    console.error("mobile storage inspection failed");
    process.exitCode = 1;
  }
}
