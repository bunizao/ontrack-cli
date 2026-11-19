import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { CliError } from "./errors.js";
import type { OktaCredentials } from "./okta-sign-in.js";

// `ontrack mcp deploy` and `ontrack mcp status`: the remote MCP Worker (src/worker)
// on the user's own Cloudflare account. The Worker ships prebuilt in dist/worker,
// so deploying needs only `npx wrangler` and a `wrangler login`.

/** Pinned to the devDependency that built the bundle; a test keeps them equal. */
export const WRANGLER = "wrangler@4.158.0";
export const WORKER_NAME = "ontrack-mcp";
const COMPATIBILITY_DATE = "2026-08-09";

export interface McpDeployment {
  readonly url: string;
  readonly owner_token: string;
}

export interface CommandResult {
  readonly code: number | null;
  readonly stdout: string;
}

/** Runs a command; `stdin` is written to it and closed. Its stderr goes to the user. */
export type CommandRunner = (command: string, args: readonly string[], options: { readonly cwd: string; readonly stdin?: string }) => Promise<CommandResult>;

export interface McpOptions {
  readonly configDir: string;
  readonly baseUrl: string;
  readonly oktaCredentials: () => Promise<OktaCredentials>;
  readonly run?: CommandRunner;
  readonly fetch?: typeof fetch;
  readonly bundle?: string;
  readonly timeZone?: string;
  readonly onProgress?: (message: string) => void;
}

export function deploymentFile(configDir: string): string {
  return join(configDir, "mcp.json");
}

export async function deployMcp(options: McpOptions): Promise<unknown> {
  const progress = options.onProgress ?? (() => undefined);
  const run = options.run ?? runCommand;
  const bundle = options.bundle ?? fileURLToPath(new URL("./worker/index.js", import.meta.url));
  if (!existsSync(bundle)) {
    throw new CliError("config", `The Worker bundle is missing at ${bundle}.`, undefined, "Run `npm run build:worker` in the ontrack-cli checkout.");
  }
  // Read before anything is deployed: a missing okta-auth setup should stop here.
  const okta = await options.oktaCredentials();
  const previous = await readDeployment(options.configDir);
  const ownerToken = previous?.owner_token ?? randomBytes(32).toString("base64url");

  const workDir = join(options.configDir, "mcp");
  await mkdir(workDir, { recursive: true, mode: 0o700 });
  const config = join(workDir, "wrangler.json");
  await writeFile(config, `${JSON.stringify(wranglerConfig(bundle, options.baseUrl, options.timeZone ?? localTimeZone()), null, 2)}\n`);

  progress(`Deploying ${WORKER_NAME} with ${WRANGLER}...`);
  const deployed = await run("npx", ["--yes", WRANGLER, "deploy", "--config", config], { cwd: workDir });
  if (deployed.code !== 0) {
    throw new CliError("config", "wrangler deploy failed.", undefined, "Run `npx wrangler login` if wrangler is not signed in, then try again.");
  }
  const origin = workerOrigin(deployed.stdout);
  if (!origin) throw new CliError("upstream_contract", "wrangler deploy printed no workers.dev URL.");

  progress("Storing the owner token and Okta credentials as Worker secrets...");
  // Secrets go through stdin, never argv, where other processes could read them.
  const secrets = {
    OWNER_TOKEN: ownerToken,
    OKTA_USERNAME: okta.username,
    OKTA_PASSWORD: okta.password,
    OKTA_TOTP_SECRET: okta.totpSecret,
  };
  const stored = await run("npx", ["--yes", WRANGLER, "secret", "bulk", "--config", config], { cwd: workDir, stdin: JSON.stringify(secrets) });
  if (stored.code !== 0) throw new CliError("config", "wrangler secret bulk failed.");

  await writeDeployment(options.configDir, { url: origin, owner_token: ownerToken });

  progress("Signing in to OnTrack from the Worker (Okta, about ten seconds)...");
  const whoami = await callTool(origin, ownerToken, "whoami", options.fetch ?? fetch);
  return {
    url: `${origin}/mcp`,
    worker: WORKER_NAME,
    signed_in_as: (whoami as { username?: unknown }).username ?? null,
    owner_token_file: deploymentFile(options.configDir),
    connect: [
      `Claude: add ${origin}/mcp as a custom connector. The approval page asks for user "ontrack" and the owner token.`,
      `Claude Code: claude mcp add --transport http ontrack ${origin}/mcp --header "Authorization: Bearer $(jq -r .owner_token ${deploymentFile(options.configDir)})"`,
    ],
  };
}

export async function mcpStatus(options: Pick<McpOptions, "configDir" | "fetch">): Promise<unknown> {
  const deployment = await readDeployment(options.configDir);
  if (!deployment) throw new CliError("config", "No remote MCP is deployed from this machine.", undefined, "Run `ontrack mcp deploy`.");
  const response = await (options.fetch ?? fetch)(`${deployment.url}/status`, {
    headers: { Authorization: `Bearer ${deployment.owner_token}` },
    signal: AbortSignal.timeout(30_000),
  }).catch(() => { throw new CliError("network", `${deployment.url} could not be reached.`); });
  if (!response.ok) throw new CliError("upstream_api", `${deployment.url}/status returned HTTP ${response.status}.`, response.status);
  return { url: `${deployment.url}/mcp`, ...(await response.json() as Record<string, unknown>) };
}

export function wranglerConfig(bundle: string, baseUrl: string, timeZone: string): Record<string, unknown> {
  return {
    name: WORKER_NAME,
    main: bundle,
    no_bundle: true,
    compatibility_date: COMPATIBILITY_DATE,
    // OAuth client ID metadata documents are fetched by URL; keep that fetch off private addresses.
    compatibility_flags: ["global_fetch_strictly_public"],
    workers_dev: true,
    preview_urls: false,
    vars: { ONTRACK_ORIGIN: baseUrl, TIME_ZONE: timeZone },
    durable_objects: { bindings: [{ name: "SESSION_BROKER", class_name: "SessionBroker" }] },
    migrations: [{ tag: "v1", new_sqlite_classes: ["SessionBroker"] }],
    // No id: wrangler creates the namespace on the first deploy.
    kv_namespaces: [{ binding: "OAUTH_KV" }],
  };
}

export function workerOrigin(output: string): string | null {
  return new RegExp(`https://${WORKER_NAME}\\.[a-z0-9-]+\\.workers\\.dev`, "iu").exec(output)?.[0] ?? null;
}

async function callTool(origin: string, token: string, name: string, fetchImplementation: typeof fetch): Promise<unknown> {
  let response: Response;
  try {
    response = await fetchImplementation(`${origin}/mcp`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json, text/event-stream", "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: {} } }),
      signal: AbortSignal.timeout(90_000),
    });
  } catch {
    throw new CliError("network", `The Worker deployed but ${origin} could not be reached yet.`, undefined, "Run `ontrack mcp status` in a minute.");
  }
  if (!response.ok) throw new CliError("upstream_api", `The Worker answered HTTP ${response.status}.`, response.status);
  const payload = await response.json() as { result?: { isError?: boolean; content?: Array<{ text?: string }> } };
  const text = payload.result?.content?.[0]?.text ?? "";
  if (payload.result?.isError || !text) {
    throw new CliError("auth", `The Worker deployed but could not sign in to OnTrack: ${text || "no answer"}`, undefined,
      "Run `ontrack mcp status` for the session state.");
  }
  return JSON.parse(text) as unknown;
}

async function readDeployment(configDir: string): Promise<McpDeployment | undefined> {
  let text: string;
  try { text = await readFile(deploymentFile(configDir), "utf8"); } catch { return undefined; }
  const data = JSON.parse(text) as Partial<McpDeployment>;
  return typeof data.url === "string" && typeof data.owner_token === "string" ? { url: data.url, owner_token: data.owner_token } : undefined;
}

async function writeDeployment(configDir: string, deployment: McpDeployment): Promise<void> {
  const file = deploymentFile(configDir);
  await writeFile(file, `${JSON.stringify(deployment, null, 2)}\n`, { mode: 0o600 });
  await chmod(file, 0o600);
}

function localTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

function runCommand(command: string, args: readonly string[], options: { readonly cwd: string; readonly stdin?: string }): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      stdio: [options.stdin === undefined ? "inherit" : "pipe", "pipe", "inherit"],
      shell: process.platform === "win32",
    });
    let stdout = "";
    // Piped above; wrangler's output also goes to the user, who may need to act on it.
    child.stdout!.setEncoding("utf8");
    child.stdout!.on("data", (chunk: string) => { stdout += chunk; process.stderr.write(chunk); });
    child.on("error", (error: NodeJS.ErrnoException) => {
      reject(error.code === "ENOENT" ? new CliError("config", `${command} is not installed.`) : error);
    });
    child.on("close", (code) => resolve({ code, stdout }));
    if (options.stdin !== undefined) child.stdin?.end(options.stdin);
  });
}
