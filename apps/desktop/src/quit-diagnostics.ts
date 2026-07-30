import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

export function desktopQuitDiagnosticsPath(
  homeDirectory = homedir(),
  platform: NodeJS.Platform = process.platform,
  environment: NodeJS.ProcessEnv = process.env,
): string {
  if (platform === "darwin") {
    return join(homeDirectory, "Library", "Logs", "T4 Code", "desktop-quit.log");
  }
  const configuredStateRoot = environment.XDG_STATE_HOME;
  const stateRoot =
    configuredStateRoot?.startsWith("/") === true
      ? configuredStateRoot
      : join(homeDirectory, ".local", "state");
  return join(stateRoot, "t4-code", "desktop-quit.log");
}

export interface DesktopQuitReporterOptions {
  readonly logPath?: string;
  readonly echo?: (message: string) => void;
  readonly now?: () => Date;
}

export function createDesktopQuitReporter(
  options: DesktopQuitReporterOptions = {},
): (message: string) => void {
  const logPath = options.logPath ?? desktopQuitDiagnosticsPath();
  const echo = options.echo ?? console.error;
  const now = options.now ?? (() => new Date());
  return (message: string): void => {
    echo(message);
    try {
      mkdirSync(dirname(logPath), { recursive: true });
      appendFileSync(logPath, `${now().toISOString()} ${message}\n`, "utf8");
    } catch {
      // Quit diagnostics must never prevent shutdown or mask the original failure.
    }
  };
}
