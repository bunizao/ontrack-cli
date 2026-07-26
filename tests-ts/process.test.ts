import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
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

async function interrupt(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (process.platform !== "win32") {
    child.kill("SIGINT");
    return;
  }
  child.stdin.write("interrupt\n");
}

function spawnInterruptible(
  executable: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
): { child: ChildProcessWithoutNullStreams; ready: Promise<void> } {
  if (process.platform !== "win32") {
    return {
      child: spawn(executable, [...args], { env, stdio: ["pipe", "pipe", "pipe"] }),
      ready: Promise.resolve(),
    };
  }
  const child = spawn("powershell.exe", [
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    "scripts/send-console-interrupt.ps1",
    "-RuntimePath",
    executable,
    "-ArgumentsJson",
    JSON.stringify(args),
  ], { env, stdio: ["pipe", "pipe", "pipe"] });
  const ready = new Promise<void>((resolve, reject) => {
    const onData = (chunk: Buffer): void => {
      if (chunk.toString("utf8").includes("ONTRACK_INTERRUPT_READY\n")) {
        child.stdout.off("data", onData);
        resolve();
      }
    };
    child.stdout.on("data", onData);
    child.once("error", reject);
    child.once("exit", (code) => reject(new Error(`Console harness exited before launch with code ${code ?? "unknown"}`)));
  });
  return { child, ready };
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

export async function test_terminal_output_preserves_unicode_and_never_emits_ansi(): Promise<void> {
  const server = createServer((request, response) => {
    assert.equal(request.url, "/api/projects?include_inactive=false");
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify([{ id: 7, unit: { id: 9, code: "FIT中文", name: "Café 🚀" } }]));
  });
  const port = await listen(server);
  try {
    const outputs: string[] = [];
    for (const columns of ["20", "120"]) {
      const result = await run(process.execPath, ["dist/cli.js", "projects"], {
        ONTRACK_BASE_URL: `http://127.0.0.1:${port}`,
        ONTRACK_USERNAME: "student",
        ONTRACK_AUTH_TOKEN: "terminal-secret",
        COLUMNS: columns,
        FORCE_COLOR: "1",
      });
      assert.equal(result.code, 0);
      assert.equal(result.stderr, "");
      assert.match(result.stdout, /FIT中文/u);
      assert.match(result.stdout, /Café 🚀/u);
      assert.doesNotMatch(result.stdout, /\u001B\[[0-?]*[ -/]*[@-~]/u);
      outputs.push(result.stdout);
    }
    assert.equal(outputs[0], outputs[1]);
  } finally {
    server.close();
    await once(server, "close");
  }
}

export async function test_console_interrupt_aborts_in_flight_request_with_exit_130(): Promise<void> {
  let requestStarted!: () => void;
  const started = new Promise<void>((resolve) => { requestStarted = resolve; });
  const server = createServer(() => requestStarted());
  const port = await listen(server);
  const { child, ready } = spawnInterruptible(
    process.execPath,
    ["dist/cli.js", "projects", "--json"],
    {
      ...process.env,
      ONTRACK_BASE_URL: `http://127.0.0.1:${port}`,
      ONTRACK_USERNAME: "student",
      ONTRACK_AUTH_TOKEN: "cancel-secret",
    },
  );
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
  try {
    await Promise.all([started, ready]);
    const exited = once(child, "exit") as Promise<[number | null, NodeJS.Signals | null]>;
    await interrupt(child);
    const outcome = await Promise.race([
      exited,
      new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 10_000)),
    ]);
    if (outcome === "timeout") child.kill();
    assert.notEqual(outcome, "timeout", "console interrupt did not stop the process");
    const [code, signal] = outcome as [number | null, NodeJS.Signals | null];
    assert.equal(code, 130);
    assert.equal(signal, null);
    assert.equal(stdout.replace(/^ONTRACK_INTERRUPT_READY\r?\n/u, ""), "");
    assert.match(stderr, /cancellation/i);
    assert.doesNotMatch(stderr, /\n\s+at\s/u);
  } finally {
    server.closeAllConnections();
    server.close();
    await once(server, "close");
  }
}
