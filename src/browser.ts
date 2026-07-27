import { spawn } from "node:child_process";

export type BrowserCommandRunner = (command: string, args: readonly string[]) => Promise<void>;

export interface OpenSystemBrowserOptions {
  readonly platform?: NodeJS.Platform;
  readonly run?: BrowserCommandRunner;
}

export function openSystemBrowser(url: string, options: OpenSystemBrowserOptions = {}): Promise<void> {
  const platform = options.platform ?? process.platform;
  const run = options.run ?? runBrowserCommand;
  if (platform === "darwin") return run("open", [url]);
  if (platform === "win32") return run("rundll32", ["url.dll,FileProtocolHandler", url]);
  return run("xdg-open", [url]);
}

function runBrowserCommand(command: string, args: readonly string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "ignore", windowsHide: true });
    child.once("error", reject);
    child.once("close", (code) => code === 0
      ? resolve()
      : reject(new Error(`Browser opener exited with code ${code ?? "unknown"}.`)));
  });
}
