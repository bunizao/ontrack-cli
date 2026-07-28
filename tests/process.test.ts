import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

interface ProcessResult {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

async function run(executable: string, args: readonly string[]): Promise<ProcessResult> {
  const child = spawn(executable, [...args], { stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
  const [code] = await once(child, "exit") as [number | null];
  return { code, stdout, stderr };
}

export async function test_distribution_help_version_and_description_run_in_node_and_bun(): Promise<void> {
  const entrypoint = resolve("dist/cli.js");
  for (const executable of [process.execPath, "bun"]) {
    const help = await run(executable, [entrypoint, "--help"]);
    assert.equal(help.code, 0, executable);
    assert.match(help.stdout, /^Usage: ontrack /u, executable);
    assert.equal(help.stderr, "", executable);

    const version = await run(executable, [entrypoint, "-V"]);
    assert.equal(version.code, 0, executable);
    assert.match(version.stdout, /^\d+\.\d+\.\d+\n$/u, executable);
    assert.equal(version.stderr, "", executable);

    const commands = await run(executable, [entrypoint, "commands", "--json"]);
    assert.equal(commands.code, 0, `${executable}: ${commands.stderr}`);
    const value = JSON.parse(commands.stdout) as { name: string; commands: unknown[] };
    assert.equal(value.name, "ontrack");
    assert.ok(value.commands.length > 0);
  }
}

export async function test_process_usage_error_is_single_structured_rendering_with_exit_two(): Promise<void> {
  const result = await run(process.execPath, [resolve("dist/cli.js"), "bogus"]);
  assert.equal(result.code, 2);
  assert.equal(result.stdout, "");
  assert.deepEqual(JSON.parse(result.stderr), {
    ok: false,
    error: { code: "usage", message: "unknown command 'bogus'" },
    exit_code: 2,
  });
}

export async function test_process_mutations_reject_noninteractive_calls_without_yes(): Promise<void> {
  const result = await run(process.execPath, [resolve("dist/cli.js"), "chats", "send", "7", "1.1", "--message", "Hello"]);
  assert.equal(result.code, 2);
  assert.equal(result.stdout, "");
  assert.equal(JSON.parse(result.stderr).error.code, "usage");
}

export async function test_process_chat_read_requires_explicit_side_effect_acknowledgement(): Promise<void> {
  const result = await run(process.execPath, [resolve("dist/cli.js"), "chats", "read", "7", "1.1"]);
  assert.equal(result.code, 2);
  assert.equal(result.stdout, "");
  const error = JSON.parse(result.stderr) as { error: { message: string; hint: string } };
  assert.match(error.error.message, /marks non-discussion comments read/u);
  assert.match(error.error.hint, /--yes/u);
}

export async function test_process_dry_run_prints_plan_without_authentication(): Promise<void> {
  const result = await run(process.execPath, [resolve("dist/cli.js"), "tasks", "set", "7", "1.1", "working_on_it", "--dry-run"]);
  assert.equal(result.code, 0);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /Set task 1\.1 in 7 to working_on_it/u);
}

export async function test_process_global_output_writes_to_a_file(): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "ontrack-output-"));
  const output = join(directory, "commands.json");
  try {
    const result = await run(process.execPath, [resolve("dist/cli.js"), "commands", "--json", "--output", output]);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "");
    const value = JSON.parse(await readFile(output, "utf8")) as { name: string };
    assert.equal(value.name, "ontrack");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export async function test_process_closed_pipe_does_not_emit_a_stack_trace(): Promise<void> {
  const entrypoint = resolve("dist/cli.js");
  const result = await run("sh", ["-c", `"${process.execPath}" "${entrypoint}" commands --json | head -c 1 >/dev/null`]);
  assert.equal(result.code, 0);
  assert.equal(result.stderr, "");
}

export async function test_distribution_cli_is_directly_executable(): Promise<void> {
  if (process.platform === "win32") return;
  const metadata = await stat("dist/cli.js");
  assert.notEqual(metadata.mode & 0o111, 0);
}
