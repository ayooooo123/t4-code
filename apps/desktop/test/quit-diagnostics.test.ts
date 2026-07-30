import { describe, expect, it } from "vitest";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createDesktopQuitReporter,
  desktopQuitDiagnosticsPath,
} from "../src/quit-diagnostics.ts";

describe("desktop quit diagnostics", () => {
  it("uses the macOS T4 Code log directory", () => {
    expect(desktopQuitDiagnosticsPath("/Users/alice", "darwin", {})).toBe(
      "/Users/alice/Library/Logs/T4 Code/desktop-quit.log",
    );
  });

  it("appends timestamped quit breadcrumbs to the configured file", async () => {
    const root = await mkdtemp(join(tmpdir(), "t4-quit-diagnostics-"));
    const logPath = join(root, "quit.log");
    const echoed: string[] = [];
    const report = createDesktopQuitReporter({
      logPath,
      echo: (message) => echoed.push(message),
      now: () => new Date("2026-07-28T17:40:14.481Z"),
    });

    report("[desktop] before-quit received");

    expect(echoed).toEqual(["[desktop] before-quit received"]);
    const content = await readFile(logPath, "utf8");
    expect(content).toBe("2026-07-28T17:40:14.481Z [desktop] before-quit received\n");
  });
});
