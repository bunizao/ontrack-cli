import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { once } from "node:events";

interface ProcessResult {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
}

async function run(executable: string, args: readonly string[], env: NodeJS.ProcessEnv = {}): Promise<ProcessResult> {
  const child = spawn(executable, [...args], {
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
  const [code, signal] = await once(child, "exit") as [number | null, NodeJS.Signals | null];
  return { code, signal, stdout, stderr };
}

async function listen(server: Server): Promise<number> {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Test server did not bind a TCP port");
  return address.port;
}

export async function test_same_artifact_runs_help_and_version_in_node_and_bun(): Promise<void> {
  const packageMetadata = JSON.parse(readFileSync("package.json", "utf8")) as { version: string };
  for (const executable of [process.execPath, "bun"]) {
    const prefix = executable === "bun" ? ["dist/cli.js"] : ["dist/cli.js"];
    const help = await run(executable, [...prefix, "--help"]);
    assert.equal(help.code, 0, executable);
    assert.match(help.stdout, /^Usage: ontrack /, executable);
    assert.equal(help.stderr, "", executable);
    const version = await run(executable, [...prefix, "--version"]);
    assert.deepEqual({ code: version.code, stdout: version.stdout, stderr: version.stderr }, {
      code: 0,
      stdout: `ontrack ${packageMetadata.version}\n`,
      stderr: "",
    }, executable);
  }
}

export async function test_process_projects_json_keeps_stdout_machine_clean(): Promise<void> {
  const server = createServer((request, response) => {
    assert.equal(request.url, "/api/projects?include_inactive=false");
    response.writeHead(200, { "content-type": "application/json" });
    response.end("[]");
  });
  const port = await listen(server);
  try {
    const result = await run(process.execPath, ["dist/cli.js", "projects", "--json"], {
      ONTRACK_BASE_URL: `http://127.0.0.1:${port}`,
      ONTRACK_USERNAME: "student",
      ONTRACK_AUTH_TOKEN: "process-secret",
      ONTRACK_CONFIG: "",
    });
    assert.deepEqual(result, { code: 0, signal: null, stdout: "[]\n", stderr: "" });
    assert.doesNotMatch(`${result.stdout}${result.stderr}`, /process-secret/);
  } finally {
    server.close();
    await once(server, "close");
  }
}

export async function test_sigint_aborts_in_flight_request_with_exit_130(): Promise<void> {
  if (process.platform === "win32") return;
  let requestStarted!: () => void;
  const started = new Promise<void>((resolve) => { requestStarted = resolve; });
  const server = createServer(() => requestStarted());
  const port = await listen(server);
  const child = spawn(process.execPath, ["dist/cli.js", "projects", "--json"], {
    env: {
      ...process.env,
      ONTRACK_BASE_URL: `http://127.0.0.1:${port}`,
      ONTRACK_USERNAME: "student",
      ONTRACK_AUTH_TOKEN: "cancel-secret",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
  try {
    await started;
    child.kill("SIGINT");
    const [code, signal] = await once(child, "exit") as [number | null, NodeJS.Signals | null];
    assert.equal(code, 130);
    assert.equal(signal, null);
    assert.equal(stdout, "");
    assert.match(stderr, /cancellation/i);
    assert.doesNotMatch(stderr, /\n\s+at\s/u);
  } finally {
    server.closeAllConnections();
    server.close();
    await once(server, "close");
  }
}
