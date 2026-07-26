import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

async function interrupt(child: ChildProcessWithoutNullStreams, interruptPath?: string): Promise<void> {
  if (process.platform !== "win32") {
    child.kill("SIGINT");
    return;
  }
  assert.ok(interruptPath);
  writeFileSync(interruptPath, "interrupt");
}

interface InterruptibleProcess {
  readonly child: ChildProcessWithoutNullStreams;
  readonly ready: Promise<void>;
  readonly controlDirectory?: string;
  readonly interruptPath?: string;
  readonly stdoutPath?: string;
  readonly stderrPath?: string;
}

function spawnInterruptible(
  executable: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
): InterruptibleProcess {
  if (process.platform !== "win32") {
    return {
      child: spawn(executable, [...args], { env, stdio: ["pipe", "pipe", "pipe"] }),
      ready: Promise.resolve(),
    };
  }
  const controlDirectory = mkdtempSync(join(tmpdir(), "ontrack-interrupt-"));
  const readyPath = join(controlDirectory, "ready");
  const interruptPath = join(controlDirectory, "interrupt");
  const stdoutPath = join(controlDirectory, "stdout");
  const stderrPath = join(controlDirectory, "stderr");
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
    "-ReadyPath",
    readyPath,
    "-InterruptPath",
    interruptPath,
    "-StdoutPath",
    stdoutPath,
    "-StderrPath",
    stderrPath,
  ], { env, stdio: ["pipe", "pipe", "pipe"] });
  const ready = new Promise<void>((resolve, reject) => {
    let settled = false;
    let poll: ReturnType<typeof setTimeout> | undefined;
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(poll);
      if (error) reject(error);
      else resolve();
    };
    const check = (): void => {
      if (existsSync(readyPath)) finish();
      else poll = setTimeout(check, 25);
    };
    check();
    child.once("error", (error) => finish(error));
    child.once("exit", (code) => finish(new Error(`Console harness exited before launch with code ${code ?? "unknown"}`)));
  });
  return { child, ready, controlDirectory, interruptPath, stdoutPath, stderrPath };
}

async function waitForInterruptReadiness(
  child: ChildProcessWithoutNullStreams,
  events: readonly Promise<unknown>[],
): Promise<void> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      Promise.all(events),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error("Console interrupt process did not become ready within 10 seconds")), 10_000);
      }),
    ]);
  } catch (error) {
    child.kill();
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

export async function test_same_artifact_runs_help_and_version_in_node_and_bun(): Promise<void> {
  const packageMetadata = JSON.parse(readFileSync("package.json", "utf8")) as { version: string };
  for (const executable of [process.execPath, "bun"]) {
    const prefix = ["dist/cli.js"];
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

export function test_distribution_cli_is_directly_executable(): void {
  if (process.platform === "win32") return;
  assert.notEqual(statSync("dist/cli.js").mode & 0o111, 0);
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
  const { child, ready, controlDirectory, interruptPath, stdoutPath, stderrPath } = spawnInterruptible(
    process.execPath,
    ["dist/cli.js", "projects", "--json"],
    {
      ...process.env,
      ONTRACK_BASE_URL: `http://127.0.0.1:${port}`,
      ONTRACK_USERNAME: "student",
      ONTRACK_AUTH_TOKEN: "cancel-secret",
    },
  );
  let wrapperStdout = "";
  let wrapperStderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => { wrapperStdout += chunk; });
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => { wrapperStderr += chunk; });
  try {
    await waitForInterruptReadiness(child, [started, ready]);
    const exited = once(child, "exit") as Promise<[number | null, NodeJS.Signals | null]>;
    await interrupt(child, interruptPath);
    const outcome = await Promise.race([
      exited,
      new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 10_000)),
    ]);
    if (outcome === "timeout") child.kill();
    assert.notEqual(outcome, "timeout", "console interrupt did not stop the process");
    const [code, signal] = outcome as [number | null, NodeJS.Signals | null];
    const stdout = stdoutPath ? readFileSync(stdoutPath, "utf8") : wrapperStdout;
    const stderr = stderrPath ? readFileSync(stderrPath, "utf8") : wrapperStderr;
    assert.equal(code, 130);
    assert.equal(signal, null);
    assert.equal(stdout, "", wrapperStdout);
    assert.match(stderr, /cancellation/i);
    assert.doesNotMatch(stderr, /\n\s+at\s/u);
  } finally {
    if (controlDirectory) rmSync(controlDirectory, { recursive: true, force: true });
    server.closeAllConnections();
    server.close();
    await once(server, "close");
  }
}
