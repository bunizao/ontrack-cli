import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { textPdf } from "./pdf-fixture.js";

interface ProcessResult {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
}

async function run(executable: string, args: readonly string[], env: NodeJS.ProcessEnv = {}, cwd?: string): Promise<ProcessResult> {
  const child = spawn(executable, [...args], {
    env: { ...process.env, ...env },
    ...(cwd ? { cwd } : {}),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
  const [code, signal] = await once(child, "exit") as [number | null, NodeJS.Signals | null];
  return { code, signal, stdout, stderr };
}

export async function test_process_chat_send_requires_yes_when_stdin_is_not_a_terminal(): Promise<void> {
  const entrypoint = resolve("dist/cli.js");
  for (const executable of [process.execPath, "bun"]) {
    const result = await run(executable, [entrypoint, "chats", "send", "5183", "P1", "--message", "Please review this."], {
      ONTRACK_USERNAME: "student",
      ONTRACK_AUTH_TOKEN: "must-not-be-used",
      ONTRACK_CONFIG: "",
    });
    assert.equal(result.code, 2, executable);
    assert.equal(result.stdout, "", executable);
    assert.match(result.stderr, /interactive terminal or --yes/i, executable);
    assert.doesNotMatch(result.stderr, /must-not-be-used/u, executable);
  }
}

export async function test_process_chat_send_posts_exact_message_in_node_and_bun_with_yes(): Promise<void> {
  const posts: Array<{ readonly method: string; readonly url: string; readonly body: string }> = [];
  const server = createServer((request, response) => {
    assert.equal(request.headers.username, "student");
    assert.equal(request.headers["auth-token"], "process-secret");
    if (request.url === "/api/projects/5183") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        id: 5183,
        unit: { id: 15, code: "FIT1045", name: "Algorithms" },
        tasks: [{ id: 21, task_definition_id: 27, status: "working_on_it" }],
      }));
      return;
    }
    if (request.url === "/api/units/15") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        id: 15,
        code: "FIT1045",
        name: "Algorithms",
        task_definitions: [{ id: 27, abbreviation: "P1", name: "Search" }],
      }));
      return;
    }
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => { body += chunk; });
    request.on("end", () => {
      posts.push({ method: request.method ?? "", url: request.url ?? "", body });
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        id: 51,
        comment: "Please review this.",
        has_attachment: false,
        type: "text",
        is_new: false,
        reply_to_id: null,
        author: { id: 1, first_name: "Example", last_name: "Student", email: "student@example.invalid" },
        recipient: { id: 2, first_name: "Example", last_name: "Tutor", email: "tutor@example.invalid" },
        created_at: "2026-07-28T03:04:05Z",
        recipient_read_time: null,
      }));
    });
  });
  const port = await listen(server);
  const entrypoint = resolve("dist/cli.js");
  try {
    for (const executable of [process.execPath, "bun"]) {
      const result = await run(executable, [entrypoint, "chats", "send", "5183", "P1", "--message", "Please review this.", "--yes", "--json"], {
        ONTRACK_BASE_URL: `http://127.0.0.1:${port}`,
        ONTRACK_USERNAME: "student",
        ONTRACK_AUTH_TOKEN: "process-secret",
        ONTRACK_CONFIG: "",
      });
      assert.equal(result.code, 0, executable);
      assert.equal(result.stderr, "", executable);
      assert.deepEqual(JSON.parse(result.stdout), {
        project_id: 5183,
        task_definition_id: 27,
        task: "P1",
        comment_id: 51,
        message: "Please review this.",
        created_at: "2026-07-28T03:04:05.000Z",
      });
    }
    assert.deepEqual(posts, [
      { method: "POST", url: "/api/projects/5183/task_def_id/27/comments", body: "comment=Please+review+this." },
      { method: "POST", url: "/api/projects/5183/task_def_id/27/comments", body: "comment=Please+review+this." },
    ]);
  } finally {
    server.close();
    await once(server, "close");
  }
}

export async function test_process_task_submit_uses_identical_multipart_in_node_and_bun(): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), "ontrack-submit-process-"));
  const report = join(directory, "report.pdf");
  const source = join(directory, "source.zip");
  writeFileSync(report, new Uint8Array([1, 2]));
  writeFileSync(source, new Uint8Array([3, 4]));
  const submissions: Array<{ readonly keys: string[]; readonly report: number[]; readonly source: number[]; readonly type: FormDataEntryValue | null; readonly comment: FormDataEntryValue | null }> = [];
  const server = createServer((request, response) => {
    assert.equal(request.headers.username, "student");
    assert.equal(request.headers["auth-token"], "process-secret");
    if (request.url === "/api/projects/5183") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        id: 5183,
        unit: { id: 15, code: "FIT1045", name: "Algorithms" },
        tasks: [{ id: 21, task_definition_id: 27, status: "working_on_it" }],
      }));
      return;
    }
    if (request.url === "/api/units/15") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        id: 15,
        code: "FIT1045",
        name: "Algorithms",
        task_definitions: [{
          id: 27,
          abbreviation: "P1",
          name: "Search",
          upload_requirements: [
            { key: "file0", name: "Report", type: "document" },
            { key: "file1", name: "Source", type: "zip" },
          ],
        }],
      }));
      return;
    }
    assert.equal(request.method, "POST");
    assert.equal(request.url, "/api/projects/5183/task_def_id/27/submission");
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      void (async () => {
        const form = await new Response(Buffer.concat(chunks), {
          headers: { "content-type": request.headers["content-type"] ?? "" },
        }).formData();
        submissions.push({
          keys: [...form.keys()],
          report: [...new Uint8Array(await (form.get("file0") as File).arrayBuffer())],
          source: [...new Uint8Array(await (form.get("file1") as File).arrayBuffer())],
          type: form.get("trigger"),
          comment: form.get("comment"),
        });
        response.writeHead(201, { "content-type": "application/json" });
        response.end(JSON.stringify({ id: 21, task_definition_id: 27, status: "need_help" }));
      })();
    });
  });
  const port = await listen(server);
  const entrypoint = resolve("dist/cli.js");
  try {
    for (const executable of [process.execPath, "bun"]) {
      const result = await run(executable, [
        entrypoint,
        "task", "submit", "5183", "P1",
        "--file", report,
        "--file", source,
        "--type", "need_help",
        "--comment", "Please help",
        "--yes",
        "--json",
      ], {
        ONTRACK_BASE_URL: `http://127.0.0.1:${port}`,
        ONTRACK_USERNAME: "student",
        ONTRACK_AUTH_TOKEN: "process-secret",
        ONTRACK_CONFIG: "",
      }, directory);
      assert.equal(result.code, 0, `${executable}: ${result.stderr}`);
      assert.equal(JSON.parse(result.stdout).processing_async, true);
    }
    assert.deepEqual(submissions, [0, 1].map(() => ({
      keys: ["file0", "file1", "trigger", "comment"],
      report: [1, 2],
      source: [3, 4],
      type: "need_help",
      comment: "Please help",
    })));
  } finally {
    rmSync(directory, { recursive: true, force: true });
    server.close();
    await once(server, "close");
  }
}

export async function test_process_reads_a_task_sheet_as_markdown_in_node_and_bun(): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), "ontrack-task-read-"));
  const pdf = textPdf(["Hello agent", "Second line"]);
  const server = createServer((request, response) => {
    assert.equal(request.headers.username, "student");
    assert.equal(request.headers["auth-token"], "process-secret");
    if (request.url === "/api/projects/5183") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ id: 5183, unit: { id: 15, code: "FIT1061", name: "AI" }, tasks: [] }));
      return;
    }
    if (request.url === "/api/units/15") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        id: 15,
        code: "FIT1061",
        name: "AI",
        task_definitions: [{ id: 27, abbreviation: "P1", name: "Search", has_task_sheet: true }],
      }));
      return;
    }
    assert.equal(request.url, "/api/units/15/task_definitions/27/task_pdf?as_attachment=true");
    response.writeHead(200, {
      "content-type": "application/pdf",
      "content-disposition": "attachment; filename=FIT1061-P1.pdf",
    });
    response.end(Buffer.from(pdf));
  });
  const port = await listen(server);
  const entrypoint = resolve("dist/cli.js");
  try {
    const outputs: string[] = [];
    for (const executable of [process.execPath, "bun"]) {
      const result = await run(executable, [entrypoint, "task", "read", "5183", "P1"], {
        ONTRACK_BASE_URL: `http://127.0.0.1:${port}`,
        ONTRACK_USERNAME: "student",
        ONTRACK_AUTH_TOKEN: "process-secret",
        ONTRACK_CONFIG: "",
      }, directory);
      assert.equal(result.code, 0, executable);
      assert.equal(result.stderr, "", executable);
      assert.equal(result.stdout, "# FIT1061 P1 Task Sheet\n\nHello agent Second line\n", executable);
      outputs.push(result.stdout);
    }
    assert.equal(outputs[0], outputs[1]);
    assert.deepEqual(readdirSync(directory), []);
  } finally {
    rmSync(directory, { recursive: true, force: true });
    server.close();
    await once(server, "close");
  }
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

export async function test_process_project_403_explains_how_to_find_an_accessible_id(): Promise<void> {
  let requests = 0;
  const server = createServer((request, response) => {
    requests += 1;
    assert.equal(request.url, "/api/projects/1");
    assert.equal(request.headers.username, "student");
    assert.equal(request.headers["auth-token"], "process-secret");
    response.writeHead(403, { "content-type": "application/json" });
    response.end('{"error":"Forbidden"}');
  });
  const port = await listen(server);
  try {
    const result = await run(process.execPath, ["dist/cli.js", "project", "1", "--json"], {
      ONTRACK_BASE_URL: `http://127.0.0.1:${port}`,
      ONTRACK_USERNAME: "student",
      ONTRACK_AUTH_TOKEN: "process-secret",
      ONTRACK_CONFIG: "",
    });
    assert.equal(requests, 1);
    assert.deepEqual(result, {
      code: 1,
      signal: null,
      stdout: "",
      stderr: "upstream api error: Project 1 is not accessible. Project arguments use the id from `ontrack projects --include-inactive`, not list positions.\n",
    });
    assert.doesNotMatch(`${result.stdout}${result.stderr}`, /process-secret|auth login/);
  } finally {
    server.close();
    await once(server, "close");
  }
}

export async function test_process_downloads_project_resources_as_an_atomic_zip(): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), "ontrack-resources-"));
  const output = join(directory, "FIT1061-resources.zip");
  const urls: string[] = [];
  const server = createServer((request, response) => {
    urls.push(request.url ?? "");
    assert.equal(request.headers.username, "student");
    assert.equal(request.headers["auth-token"], "process-secret");
    if (request.url === "/api/projects/5183") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        id: 5183,
        unit: { id: 15, code: "FIT1061", name: "Introduction to artificial intelligence" },
        tasks: [],
      }));
      return;
    }
    assert.equal(request.url, "/api/units/15/all_resources");
    response.writeHead(200, {
      "content-type": "application/octet-stream",
      "content-disposition": 'attachment; filename="FIT1061-resources.zip"',
    });
    response.end(Buffer.from("UEsFBgAAAAAAAAAAAAAAAAAAAAAAAA==", "base64"));
  });
  const port = await listen(server);
  try {
    const result = await run(process.execPath, [
      "dist/cli.js",
      "resources",
      "download",
      "5183",
      "--output",
      output,
      "--json",
    ], {
      ONTRACK_BASE_URL: `http://127.0.0.1:${port}`,
      ONTRACK_USERNAME: "student",
      ONTRACK_AUTH_TOKEN: "process-secret",
      ONTRACK_CONFIG: "",
    });
    assert.deepEqual(urls, ["/api/projects/5183", "/api/units/15/all_resources"]);
    assert.equal(readFileSync(output).toString("base64"), "UEsFBgAAAAAAAAAAAAAAAAAAAAAAAA==");
    assert.deepEqual(readdirSync(directory), ["FIT1061-resources.zip"]);
    assert.deepEqual(result, {
      code: 0,
      signal: null,
      stdout: `${JSON.stringify({
        project_id: 5183,
        unit_id: 15,
        archive_path: output,
        bytes_written: 22,
      }, null, 2)}\n`,
      stderr: "",
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
    server.close();
    await once(server, "close");
  }
}

export async function test_process_resource_download_preserves_an_existing_file(): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), "ontrack-resources-existing-"));
  const output = join(directory, "resources.zip");
  writeFileSync(output, "existing");
  let requests = 0;
  const server = createServer((request, response) => {
    requests += 1;
    if (request.url === "/api/projects/5183") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ id: 5183, unit: { id: 15, code: "FIT1061", name: "AI" }, tasks: [] }));
      return;
    }
    response.writeHead(200, { "content-type": "application/octet-stream" });
    response.end(Buffer.from("UEsFBgAAAAAAAAAAAAAAAAAAAAAAAA==", "base64"));
  });
  const port = await listen(server);
  try {
    const result = await run(process.execPath, [
      "dist/cli.js",
      "resources",
      "download",
      "5183",
      "--output",
      output,
      "--json",
    ], {
      ONTRACK_BASE_URL: `http://127.0.0.1:${port}`,
      ONTRACK_USERNAME: "student",
      ONTRACK_AUTH_TOKEN: "process-secret",
      ONTRACK_CONFIG: "",
    });
    assert.equal(result.code, 2);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /Output file already exists/u);
    assert.equal(readFileSync(output, "utf8"), "existing");
    assert.deepEqual(new Set(readdirSync(directory)), new Set(["resources.zip"]));
    assert.equal(requests, 0);
  } finally {
    rmSync(directory, { recursive: true, force: true });
    server.close();
    await once(server, "close");
  }
}

export async function test_process_downloads_one_task_sheet_through_the_packaged_cli(): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), "ontrack-task-sheet-process-"));
  const output = join(directory, "FIT1061-1.1.pdf");
  const urls: string[] = [];
  const pdf = Buffer.from("%PDF-1.4\nsynthetic task sheet\n");
  const server = createServer((request, response) => {
    urls.push(request.url ?? "");
    assert.equal(request.headers.username, "student");
    assert.equal(request.headers["auth-token"], "process-secret");
    if (request.url === "/api/projects/5183") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        id: 5183,
        unit: { id: 15, code: "FIT1061", name: "Algorithms and programming fundamentals" },
        tasks: [{ id: 21, task_definition_id: 27, status: "not_started" }],
      }));
      return;
    }
    if (request.url === "/api/units/15") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        id: 15,
        code: "FIT1061",
        name: "Algorithms and programming fundamentals",
        task_definitions: [{ id: 27, abbreviation: "1.1", name: "Search", has_task_sheet: true }],
      }));
      return;
    }
    assert.equal(request.url, "/api/units/15/task_definitions/27/task_pdf?as_attachment=true");
    response.writeHead(200, {
      "content-type": "application/pdf",
      "content-disposition": 'attachment; filename="FIT1061-1.1.pdf"',
    });
    response.end(pdf);
  });
  const port = await listen(server);
  try {
    const result = await run(process.execPath, [
      "dist/cli.js",
      "task",
      "sheet",
      "5183",
      "1.1",
      "--output",
      output,
    ], {
      ONTRACK_BASE_URL: `http://127.0.0.1:${port}`,
      ONTRACK_USERNAME: "student",
      ONTRACK_AUTH_TOKEN: "process-secret",
      ONTRACK_CONFIG: "",
    });
    assert.deepEqual(urls, [
      "/api/projects/5183",
      "/api/units/15",
      "/api/units/15/task_definitions/27/task_pdf?as_attachment=true",
    ]);
    assert.deepEqual(readFileSync(output), pdf);
    assert.deepEqual(readdirSync(directory), ["FIT1061-1.1.pdf"]);
    assert.equal(result.code, 0);
    assert.equal(result.signal, null);
    assert.equal(result.stderr, "");
    assert.match(result.stdout, /Project\s+Unit\s+Task\s+File\s+Size/u);
    assert.match(result.stdout, new RegExp(`5183\\s+15\\s+1\\.1\\s+${output.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "u"));
    assert.doesNotMatch(`${result.stdout}${result.stderr}`, /process-secret/u);
  } finally {
    rmSync(directory, { recursive: true, force: true });
    server.close();
    await once(server, "close");
  }
}

export async function test_process_downloads_one_task_resources_file_through_the_packaged_cli(): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), "ontrack-task-resources-process-"));
  const output = join(directory, "FIT1061-1.1-resources.zip");
  const urls: string[] = [];
  const archive = Buffer.from("UEsFBgAAAAAAAAAAAAAAAAAAAAAAAA==", "base64");
  const server = createServer((request, response) => {
    urls.push(request.url ?? "");
    assert.equal(request.headers.username, "student");
    assert.equal(request.headers["auth-token"], "process-secret");
    if (request.url === "/api/projects/5183") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        id: 5183,
        unit: { id: 15, code: "FIT1061", name: "Algorithms and programming fundamentals" },
        tasks: [{ id: 21, task_definition_id: 27, status: "not_started" }],
      }));
      return;
    }
    if (request.url === "/api/units/15") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        id: 15,
        code: "FIT1061",
        name: "Algorithms and programming fundamentals",
        task_definitions: [{ id: 27, abbreviation: "1.1", name: "Search", has_task_resources: true }],
      }));
      return;
    }
    assert.equal(request.url, "/api/units/15/task_definitions/27/task_resources");
    response.writeHead(200, {
      "content-type": "application/zip",
      "content-disposition": 'attachment; filename="FIT1061-1.1-resources.zip"',
    });
    response.end(archive);
  });
  const port = await listen(server);
  try {
    const result = await run(process.execPath, [
      "dist/cli.js",
      "task",
      "resources",
      "5183",
      "1.1",
      "--output",
      output,
    ], {
      ONTRACK_BASE_URL: `http://127.0.0.1:${port}`,
      ONTRACK_USERNAME: "student",
      ONTRACK_AUTH_TOKEN: "process-secret",
      ONTRACK_CONFIG: "",
    });
    assert.deepEqual(urls, [
      "/api/projects/5183",
      "/api/units/15",
      "/api/units/15/task_definitions/27/task_resources",
    ]);
    assert.deepEqual(readFileSync(output), archive);
    assert.deepEqual(readdirSync(directory), ["FIT1061-1.1-resources.zip"]);
    assert.equal(result.code, 0);
    assert.equal(result.signal, null);
    assert.equal(result.stderr, "");
    assert.match(result.stdout, /Project\s+Unit\s+Task\s+File\s+Size/u);
    assert.match(result.stdout, new RegExp(`5183\\s+15\\s+1\\.1\\s+${output.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "u"));
    assert.doesNotMatch(`${result.stdout}${result.stderr}`, /process-secret/u);
  } finally {
    rmSync(directory, { recursive: true, force: true });
    server.close();
    await once(server, "close");
  }
}

export async function test_process_chats_summary_is_a_human_table_without_reading_chat_history(): Promise<void> {
  const urls: string[] = [];
  const server = createServer((request, response) => {
    urls.push(request.url ?? "");
    assert.equal(request.headers.username, "student");
    assert.equal(request.headers["auth-token"], "process-secret");
    response.writeHead(200, { "content-type": "application/json" });
    if (request.url === "/api/projects/5183") {
      response.end(JSON.stringify({
        id: 5183,
        unit: { id: 15, code: "FIT1061", name: "Algorithms and programming fundamentals" },
        tasks: [{ id: 21, task_definition_id: 27, status: "rediscuss", num_new_comments: 3 }],
      }));
      return;
    }
    assert.equal(request.url, "/api/units/15");
    response.end(JSON.stringify({
      id: 15,
      code: "FIT1061",
      name: "Algorithms and programming fundamentals",
      task_definitions: [{ id: 27, abbreviation: "1.1", name: "Search" }],
    }));
  });
  const port = await listen(server);
  try {
    const result = await run(process.execPath, ["dist/cli.js", "chats", "5183"], {
      ONTRACK_BASE_URL: `http://127.0.0.1:${port}`,
      ONTRACK_USERNAME: "student",
      ONTRACK_AUTH_TOKEN: "process-secret",
      ONTRACK_CONFIG: "",
    });
    assert.deepEqual(urls, ["/api/projects/5183", "/api/units/15"]);
    assert.deepEqual(result, {
      code: 0,
      signal: null,
      stdout: [
        "Task  Name    Status     Unread",
        "----  ------  ---------  ------",
        "1.1   Search  rediscuss  3",
        "",
      ].join("\n"),
      stderr: "",
    });
  } finally {
    server.close();
    await once(server, "close");
  }
}

export async function test_process_task_chat_history_warns_that_viewing_marks_comments_read(): Promise<void> {
  const urls: string[] = [];
  const server = createServer((request, response) => {
    urls.push(request.url ?? "");
    assert.equal(request.headers.username, "student");
    assert.equal(request.headers["auth-token"], "process-secret");
    response.writeHead(200, { "content-type": "application/json" });
    if (request.url === "/api/projects/5183") {
      response.end(JSON.stringify({
        id: 5183,
        unit: { id: 15, code: "FIT1061", name: "Algorithms and programming fundamentals" },
        tasks: [{ id: 21, task_definition_id: 27, status: "rediscuss", num_new_comments: 1 }],
      }));
      return;
    }
    if (request.url === "/api/units/15") {
      response.end(JSON.stringify({
        id: 15,
        code: "FIT1061",
        name: "Algorithms and programming fundamentals",
        task_definitions: [{ id: 27, abbreviation: "1.1", name: "Search" }],
      }));
      return;
    }
    assert.equal(request.url, "/api/projects/5183/task_def_id/27/comments");
    response.end(JSON.stringify([{
      id: 41,
      comment: "Please review the search heuristic.",
      has_attachment: false,
      type: "text",
      is_new: true,
      reply_to_id: null,
      author: { id: 2, first_name: "Example", last_name: "Tutor", email: "tutor@example.invalid" },
      recipient: { id: 1, first_name: "Example", last_name: "Student", email: "student@example.invalid" },
      created_at: "2026-07-28T01:02:03.000Z",
      recipient_read_time: null,
    }]));
  });
  const port = await listen(server);
  try {
    const result = await run(process.execPath, ["dist/cli.js", "chats", "5183", "1.1"], {
      ONTRACK_BASE_URL: `http://127.0.0.1:${port}`,
      ONTRACK_USERNAME: "student",
      ONTRACK_AUTH_TOKEN: "process-secret",
      ONTRACK_CONFIG: "",
    });
    assert.deepEqual(urls, [
      "/api/projects/5183",
      "/api/units/15",
      "/api/projects/5183/task_def_id/27/comments",
    ]);
    assert.equal(result.code, 0);
    assert.equal(result.signal, null);
    assert.match(result.stdout, /Time\s+Author\s+Type\s+Message\s+Attachment\s+Reply To/u);
    assert.match(result.stdout, /Example Tutor\s+text\s+Please review the search heuristic\.\s+No/u);
    assert.doesNotMatch(result.stdout, /tutor@example\.invalid|student@example\.invalid/u);
    assert.equal(result.stderr, "Note: Viewing task chat marks its non-discussion comments as read in OnTrack.\n");
    assert.doesNotMatch(`${result.stdout}${result.stderr}`, /process-secret/u);
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
