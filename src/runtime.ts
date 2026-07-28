import { spawn } from "node:child_process";

import { CliError } from "./errors.js";

const SQLITE_REEXEC_MARKER = "ONTRACK_NODE_SQLITE_REEXEC";

export function assertSupportedRuntime(nodeVersion: string, bunVersion?: string): void {
  if (bunVersion) return;
  const [majorText, minorText] = nodeVersion.split(".");
  const major = Number.parseInt(majorText ?? "", 10);
  const minor = Number.parseInt(minorText ?? "", 10);
  if (major > 22 || (major === 22 && minor >= 5)) return;
  throw new CliError("config", `Node.js ${nodeVersion} is unsupported. OnTrack requires Node.js 22.5 or newer, or Bun.`);
}

export interface NodeSqliteRuntime {
  readonly nodeVersion: string;
  readonly bunVersion: string | undefined;
  readonly execArgv: readonly string[];
  readonly argv: readonly string[];
  readonly nodeOptions?: string | undefined;
  readonly reexecMarker?: string | undefined;
}

export function nodeSqliteRelaunchArgs(runtime: NodeSqliteRuntime): string[] | undefined {
  if (runtime.bunVersion || runtime.reexecMarker === "1") return undefined;
  if (runtime.execArgv.includes("--experimental-sqlite") || runtime.nodeOptions?.includes("--experimental-sqlite")) {
    return undefined;
  }
  const [majorText, minorText] = runtime.nodeVersion.split(".");
  const major = Number.parseInt(majorText ?? "", 10);
  const minor = Number.parseInt(minorText ?? "", 10);
  const needsFlag = (major === 22 && minor >= 5 && minor <= 12)
    || (major === 23 && minor >= 0 && minor <= 3);
  if (!needsFlag) return undefined;
  return [
    "--experimental-sqlite",
    "--disable-warning=ExperimentalWarning",
    ...runtime.execArgv,
    ...runtime.argv.slice(1),
  ];
}

export async function relaunchForNodeSqlite(): Promise<number | undefined> {
  const args = nodeSqliteRelaunchArgs({
    nodeVersion: process.versions.node,
    bunVersion: Reflect.get(process.versions, "bun") as string | undefined,
    execArgv: process.execArgv,
    argv: process.argv,
    nodeOptions: process.env.NODE_OPTIONS,
    reexecMarker: process.env[SQLITE_REEXEC_MARKER],
  });
  if (!args) return undefined;
  const child = spawn(process.execPath, args, {
    stdio: "inherit",
    shell: false,
    env: { ...process.env, [SQLITE_REEXEC_MARKER]: "1" },
  });
  const signals: NodeJS.Signals[] = process.platform === "win32"
    ? ["SIGINT", "SIGTERM", "SIGBREAK"]
    : ["SIGINT", "SIGTERM"];
  const relay = (signal: NodeJS.Signals): void => { child.kill(signal); };
  for (const signal of signals) process.on(signal, relay);
  try {
    return await new Promise<number>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (status, signal) => {
        if (typeof status === "number") resolve(status);
        else if (signal === "SIGINT") resolve(130);
        else if (signal === "SIGTERM") resolve(143);
        else resolve(1);
      });
    });
  } finally {
    for (const signal of signals) process.removeListener(signal, relay);
  }
}
