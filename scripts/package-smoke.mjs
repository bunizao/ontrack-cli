import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";

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

async function interrupt(child, workspace) {
  if (process.platform !== "win32") {
    child.kill("SIGINT");
    return;
  }
  const result = await run("powershell.exe", [
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    join(workspace, "scripts", "send-console-interrupt.ps1"),
    "-TargetPid",
    String(child.pid),
  ]);
  assert(result.code === 0, `Could not send Windows Ctrl+C: ${result.stderr}`);
}

function fakeOkta(directory) {
  const payload = '{"cookies":[{"name":"username","value":"student","domain":"127.0.0.1","path":"/"},{"name":"refresh_token","value":"refresh","domain":"127.0.0.1","path":"/"}]}';
  if (process.platform === "win32") {
    writeFileSync(join(directory, "okta.cmd"), `@echo off\r\necho ${payload}\r\n`);
  } else {
    const path = join(directory, "okta");
    writeFileSync(path, `#!/bin/sh\nprintf '%s' '${payload}'\n`);
    chmodSync(path, 0o755);
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
    const packed = spawnSync(executable("npm"), ["pack", "--json"], { cwd: workspace, encoding: "utf8", shell: process.platform === "win32" });
    assert(packed.status === 0, packed.stderr || "npm pack failed");
    tarball = resolve(workspace, JSON.parse(packed.stdout)[0].filename);
    const installed = spawnSync(executable("npm"), ["install", "--prefix", temporary, tarball], { encoding: "utf8", shell: process.platform === "win32" });
    assert(installed.status === 0, installed.stderr || "tarball installation failed");
    const cli = join(temporary, "node_modules", "@bunizao", "ontrack", "dist", "cli.js");
    const shim = join(temporary, "node_modules", ".bin", executable("ontrack"));

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
      }
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Smoke server did not bind a port");
    fakeOkta(temporary);
    const authenticatedEnv = {
      ...process.env,
      ONTRACK_BASE_URL: `http://127.0.0.1:${address.port}`,
      ONTRACK_CONFIG: join(temporary, "config.yaml"),
      PATH: `${temporary}${delimiter}${process.env.PATH ?? ""}`,
    };
    delete authenticatedEnv.ONTRACK_USERNAME;
    delete authenticatedEnv.ONTRACK_AUTH_TOKEN;
    for (const runtime of runtimes) {
      rmSync(join(temporary, "session.json"), { force: true });
      const projects = await run(runtime, [cli, "projects", "--json"], authenticatedEnv);
      assert(projects.code === 0 && projects.stdout === "[]\n" && projects.stderr === "", `${runtime} projects failed: ${projects.stderr}`);
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
        rmSync(join(temporary, "session.json"), { force: true });
        server.removeAllListeners("request");
        let hangStartedResolve;
        const hangStarted = new Promise((resolveStarted) => { hangStartedResolve = resolveStarted; });
        server.on("request", () => hangStartedResolve());
        const child = spawn(runtime, [cli, "projects", "--json"], {
          env: authenticatedEnv,
          stdio: ["ignore", "pipe", "pipe"],
          detached: process.platform === "win32",
        });
        let stdout = "";
        let stderr = "";
        child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
        child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
        await hangStarted;
        const exited = once(child, "exit");
        await interrupt(child, workspace);
        const outcome = await Promise.race([
          exited,
          new Promise((resolveTimeout) => setTimeout(() => resolveTimeout("timeout"), 10_000)),
        ]);
        if (outcome === "timeout") child.kill();
        assert(outcome !== "timeout", `${runtime} installed console interrupt timed out`);
        const [code] = outcome;
        assert(code === 130 && stdout === "" && /cancellation/i.test(stderr), `${runtime} installed console interrupt behavior failed`);
    }
  } finally {
    server?.closeAllConnections();
    server?.close();
    if (tarball) rmSync(tarball, { force: true });
    rmSync(temporary, { recursive: true, force: true });
  }
}

await main();
