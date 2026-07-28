import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

function executable(name) {
  return process.platform === "win32" ? `${name}.cmd` : name;
}

function runtimeExecutable(name) {
  if (process.platform !== "win32") return name;
  const located = spawnSync("where.exe", [name], { encoding: "utf8" });
  if (located.status !== 0) return name;
  return located.stdout.split(/\r?\n/).find((path) => path.toLowerCase().endsWith(".exe")) ?? name;
}

function run(command, args, env = process.env) {
  return new Promise((resolveResult, reject) => {
    const child = spawn(command, args, {
      env,
      stdio: ["ignore", "pipe", "pipe"],
      shell: process.platform === "win32" && command.toLowerCase().endsWith(".cmd"),
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("exit", (code, signal) => resolveResult({ code, signal, stdout, stderr }));
  });
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function interrupt(child, interruptPath) {
  if (process.platform !== "win32") {
    child.kill("SIGINT");
    return;
  }
  writeFileSync(interruptPath, "interrupt");
}

function spawnInterruptible(runtime, args, env, workspace) {
  if (process.platform !== "win32") {
    return {
      child: spawn(runtime, args, { env, stdio: ["ignore", "pipe", "pipe"] }),
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
    join(workspace, "scripts", "send-console-interrupt.ps1"),
    "-RuntimePath",
    runtime,
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
  const ready = new Promise((resolveReady, reject) => {
    let settled = false;
    let poll;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(poll);
      if (error) reject(error);
      else resolveReady();
    };
    const check = () => {
      if (existsSync(readyPath)) finish();
      else poll = setTimeout(check, 25);
    };
    check();
    child.once("error", (error) => finish(error));
    child.once("exit", (code) => finish(new Error(`Console harness exited before launch with code ${code ?? "unknown"}`)));
  });
  return { child, ready, controlDirectory, interruptPath, stdoutPath, stderrPath };
}

const interruptReadyTimeoutMs = 30_000;

async function waitForInterruptReadiness(child, events) {
  let timeout;
  try {
    await Promise.race([
      Promise.all(events),
      new Promise((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error(`Console interrupt process did not become ready within ${interruptReadyTimeoutMs / 1_000} seconds`)),
          interruptReadyTimeoutMs,
        );
      }),
    ]);
  } catch (error) {
    child.kill();
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function main() {
  const workspace = process.cwd();
  const packageMetadata = JSON.parse(readFileSync(join(workspace, "package.json"), "utf8"));
  const expectedVersion = `ontrack ${packageMetadata.version}\n`;
  const temporary = mkdtempSync(join(tmpdir(), "ontrack-package-smoke-"));
  let tarball;
  let server;
  try {
    const built = spawnSync(executable("npm"), ["run", "build"], { cwd: workspace, encoding: "utf8", shell: process.platform === "win32" });
    assert(built.status === 0, built.stderr || "package build failed");
    const packed = spawnSync(executable("npm"), ["pack", "--json"], { cwd: workspace, encoding: "utf8", shell: process.platform === "win32" });
    assert(packed.status === 0, packed.stderr || "npm pack failed");
    tarball = resolve(workspace, JSON.parse(packed.stdout)[0].filename);
    const installed = spawnSync(executable("npm"), ["install", "--prefix", temporary, tarball], { encoding: "utf8", shell: process.platform === "win32" });
    assert(installed.status === 0, installed.stderr || "tarball installation failed");
    const packageRoot = join(temporary, "node_modules", "@bunizao", "ontrack");
    const cli = join(packageRoot, "dist", "cli.js");
    const shim = join(temporary, "node_modules", ".bin", executable("ontrack"));
    const bundledCookieReader = join(
      packageRoot,
      "node_modules",
      "@steipete",
      "sweet-cookie",
      "dist",
      "providers",
      "chromeSqlite",
      "shared.js",
    );
    assert(
      readFileSync(bundledCookieReader, "utf8").includes("statement.setReadBigInts(true)"),
      "packed browser cookie reader is missing the Node 22 bigint fix",
    );

    const shimHelp = await run(shim, ["--help"]);
    assert(shimHelp.code === 0 && shimHelp.stdout.startsWith("Usage: ontrack ") && shimHelp.stderr === "", "installed shim help failed");
    const shimVersion = await run(shim, ["--version"]);
    assert(shimVersion.code === 0 && shimVersion.stdout === expectedVersion && shimVersion.stderr === "", "installed shim version failed");

    const runtimes = [process.execPath, runtimeExecutable("bun")];
    for (const runtime of runtimes) {
      const help = await run(runtime, [cli, "--help"]);
      assert(help.code === 0 && help.stdout.startsWith("Usage: ontrack ") && help.stderr === "", `${runtime} help failed`);
      const version = await run(runtime, [cli, "--version"]);
      assert(version.code === 0 && version.stdout === expectedVersion && version.stderr === "", `${runtime} version failed`);
    }

    server = createServer((request, response) => {
      if (request.url === "/api/auth/access-token") {
        response.writeHead(201, { "content-type": "application/json" });
        response.end(JSON.stringify({
          auth_token: "access-token",
          auth_token_expiry: "2099-01-01T00:00:00Z",
          user: { id: 1, username: "student" },
        }));
        return;
      }
      if (request.url === "/api/projects?include_inactive=false") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end("[]");
        return;
      }
      if (request.url === "/api/projects/5183") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ id: 5183, unit: { id: 15, code: "FIT1061", name: "AI" }, tasks: [] }));
        return;
      }
      if (request.url === "/api/units/15/all_resources") {
        response.writeHead(200, { "content-type": "application/octet-stream" });
        response.end(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
      }
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Smoke server did not bind a port");
    const authenticatedEnv = {
      ...process.env,
      ONTRACK_BASE_URL: `http://127.0.0.1:${address.port}`,
      ONTRACK_CONFIG: join(temporary, "config.yaml"),
      ONTRACK_USERNAME: "student",
      ONTRACK_AUTH_TOKEN: "access-token",
    };
    for (const [index, runtime] of runtimes.entries()) {
      rmSync(join(temporary, "session.json"), { force: true });
      const projects = await run(runtime, [cli, "projects", "--json"], authenticatedEnv);
      assert(projects.code === 0 && projects.stdout === "[]\n" && projects.stderr === "", `${runtime} projects failed: ${projects.stderr}`);
      const archive = join(temporary, `resources-${index}.zip`);
      const resources = await run(runtime, [cli, "resources", "download", "5183", "--output", archive, "--json"], authenticatedEnv);
      const receipt = JSON.parse(resources.stdout || "null");
      assert(resources.code === 0 && resources.stderr === "", `${runtime} resource download failed: ${resources.stderr}`);
      assert(receipt?.archive_path === archive && receipt?.bytes_written === 4, `${runtime} resource receipt is invalid`);
      assert(readFileSync(archive).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04])), `${runtime} resource archive is invalid`);
    }
    rmSync(join(temporary, "session.json"), { force: true });
    const shimProjects = await run(shim, ["projects", "--json"], authenticatedEnv);
    assert(shimProjects.code === 0 && shimProjects.stdout === "[]\n" && shimProjects.stderr === "", `installed shim projects failed: ${shimProjects.stderr}`);

    const errorEnv = { ...process.env, ONTRACK_CONFIG: join(temporary, "missing.yaml") };
    delete errorEnv.ONTRACK_BASE_URL;
    delete errorEnv.ONTRACK_USERNAME;
    delete errorEnv.ONTRACK_AUTH_TOKEN;
    const shimError = await run(shim, ["projects", "--json"], errorEnv);
    assert(shimError.code === 1 && shimError.stdout === "" && /config error/i.test(shimError.stderr), "installed shim representative error failed");
    for (const runtime of runtimes) {
      const error = await run(runtime, [cli, "projects", "--json"], errorEnv);
      assert(error.code === 1 && error.stdout === "" && /config error/i.test(error.stderr), `${runtime} representative error failed`);
    }

    for (const runtime of runtimes) {
      let controlDirectory;
      try {
        rmSync(join(temporary, "session.json"), { force: true });
        server.removeAllListeners("request");
        let hangStartedResolve;
        const hangStarted = new Promise((resolveStarted) => { hangStartedResolve = resolveStarted; });
        server.on("request", () => hangStartedResolve());
        const interruptible = spawnInterruptible(runtime, [cli, "projects", "--json"], authenticatedEnv, workspace);
        const { child, ready, interruptPath, stdoutPath, stderrPath } = interruptible;
        controlDirectory = interruptible.controlDirectory;
        let wrapperStdout = "";
        let wrapperStderr = "";
        child.stdout.setEncoding("utf8").on("data", (chunk) => { wrapperStdout += chunk; });
        child.stderr.setEncoding("utf8").on("data", (chunk) => { wrapperStderr += chunk; });
        await waitForInterruptReadiness(child, [hangStarted, ready]);
        const exited = once(child, "exit");
        await interrupt(child, interruptPath);
        const outcome = await Promise.race([
          exited,
          new Promise((resolveTimeout) => setTimeout(() => resolveTimeout("timeout"), 10_000)),
        ]);
        if (outcome === "timeout") child.kill();
        assert(outcome !== "timeout", `${runtime} installed console interrupt timed out`);
        const [code] = outcome;
        const stdout = stdoutPath ? readFileSync(stdoutPath, "utf8") : wrapperStdout;
        const stderr = stderrPath ? readFileSync(stderrPath, "utf8") : wrapperStderr;
        assert(code === 130 && stdout === "" && /cancellation/i.test(stderr), `${runtime} installed console interrupt behavior failed: ${wrapperStderr}`);
      } finally {
        if (controlDirectory) rmSync(controlDirectory, { recursive: true, force: true });
      }
    }
  } finally {
    server?.closeAllConnections();
    server?.close();
    if (tarball) rmSync(tarball, { force: true });
    rmSync(temporary, { recursive: true, force: true });
  }
}

await main();
