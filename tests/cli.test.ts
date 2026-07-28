import assert from "node:assert/strict";

import { VERBS } from "@bunizao/cli-kit";

import { executeCli, type ChatSendConfirmation, type CliApplication } from "../src/cli-app.js";
import { CliError } from "../src/errors.js";
import type { TaskSubmissionPlan } from "../src/submission.js";

interface Call {
  readonly name: keyof CliApplication;
  readonly args: readonly unknown[];
}

function fakeApplication(): { readonly app: CliApplication; readonly calls: Call[] } {
  const calls: Call[] = [];
  const value = (name: keyof CliApplication, result: unknown) => async (...args: unknown[]): Promise<unknown> => {
    calls.push({ name, args });
    return result;
  };
  const submissionPlan: TaskSubmissionPlan = {
    projectId: 7,
    taskDefinitionId: 12,
    task: "1.1",
    previousStatus: "working_on_it",
    type: "ready_for_feedback",
    acceptTiiEula: false,
    uploads: [],
  };
  const chatPlan: ChatSendConfirmation = { projectId: 7, taskDefinitionId: 12, task: "1.1", message: "Hello" };
  return {
    app: {
      resolveProject: value("resolveProject", 7) as CliApplication["resolveProject"],
      user: value("user", { username: "student", auth_token: "secret" }),
      authCheck: value("authCheck", { username: "student" }),
      projects: value("projects", [{ id: 7, unit: { code: "FIT1045" } }]),
      project: value("project", { id: 7 }),
      tasks: value("tasks", [{ task: "1.1", status: "working_on_it" }]),
      taskShow: value("taskShow", { task: "1.1" }),
      resourcesDownload: value("resourcesDownload", { archive_path: "/tmp/resources.zip" }),
      taskSheetDownload: value("taskSheetDownload", { file_path: "/tmp/task.pdf" }),
      taskResourcesDownload: value("taskResourcesDownload", { file_path: "/tmp/resources.zip" }),
      taskRead: value("taskRead", { markdown: "# Task\n" }),
      taskState: value("taskState", { status: "working_on_it" }),
      prepareTaskSubmission: value("prepareTaskSubmission", submissionPlan) as CliApplication["prepareTaskSubmission"],
      submitTask: value("submitTask", { status: "ready_for_feedback" }) as CliApplication["submitTask"],
      chats: value("chats", [{ task: "1.1", unread_comments: 1 }]),
      chatMarkRead: value("chatMarkRead", { marked_read: true }),
      prepareChatSend: value("prepareChatSend", chatPlan) as CliApplication["prepareChatSend"],
      chatSend: value("chatSend", { message: "Hello" }) as CliApplication["chatSend"],
      roles: value("roles", []),
    },
    calls,
  };
}

export async function test_normalized_nouns_and_arity_defaults_reach_the_application(): Promise<void> {
  const { app, calls } = fakeApplication();
  for (const argv of [
    ["units"],
    ["courses", "FIT1045"],
    ["projects", "7"],
    ["tasks", "FIT1045", "--status", "rediscuss"],
    ["tasks", "FIT1045", "1.1"],
    ["chats", "FIT1045"],
    ["chats", "FIT1045", "1.1"],
    ["roles"],
  ]) {
    const result = await executeCli(argv, { app, version: "1.0.0" });
    assert.equal(result.exitCode, 0, `${argv.join(" ")}: ${result.stderr}`);
  }
  assert.deepEqual(calls.map(({ name }) => name), [
    "projects", "resolveProject", "project", "project", "resolveProject", "tasks",
    "resolveProject", "taskShow", "resolveProject", "chats", "resolveProject", "chats", "roles",
  ]);
}

export async function test_help_version_and_command_description_are_machine_clean(): Promise<void> {
  const { app, calls } = fakeApplication();
  for (const argv of [["--help"], ["-h"], ["help", "tasks"], ["-V"]]) {
    const result = await executeCli(argv, { app, version: "1.2.3" });
    assert.equal(result.exitCode, 0);
    assert.equal(result.stderr, "");
    assert.ok(result.stdout.length > 0);
  }
  const described = await executeCli(["commands", "--json"], { app, version: "1.2.3" });
  const tree = JSON.parse(described.stdout) as { commands: Array<{ commands: Array<{ verb?: string; mutating: boolean }> }> };
  const verbs = tree.commands.flatMap((noun) => noun.commands.map((command) => command.verb).filter(Boolean));
  assert.equal(verbs.every((verb) => VERBS.includes(verb as typeof VERBS[number])), true);
  assert.equal(tree.commands.flatMap((noun) => noun.commands).every((command) => typeof command.mutating === "boolean"), true);
  assert.deepEqual(calls, []);
}

export async function test_output_defaults_to_json_for_pipes_and_table_for_terminals(): Promise<void> {
  const piped = await executeCli(["units"], { app: fakeApplication().app, version: "1.0.0", stdoutIsTty: false });
  assert.deepEqual(JSON.parse(piped.stdout), [{ id: 7, unit: { code: "FIT1045" } }]);
  const terminal = await executeCli(["units"], { app: fakeApplication().app, version: "1.0.0", stdoutIsTty: true });
  assert.match(terminal.stdout, /^id\s+unit/mu);
  const yaml = await executeCli(["units", "--yaml"], { app: fakeApplication().app, version: "1.0.0" });
  assert.match(yaml.stdout, /code: FIT1045/u);
}

export async function test_output_flags_are_exclusive_and_fields_filter_top_level_values(): Promise<void> {
  const conflict = await executeCli(["units", "--json", "--yaml"], { app: fakeApplication().app, version: "1.0.0" });
  assert.equal(conflict.exitCode, 2);
  assert.equal(conflict.stdout, "");
  assert.equal(conflict.stderr, "error: --json, --yaml, and --table are mutually exclusive.\n");
  const selected = await executeCli(["units", "--fields", "id"], { app: fakeApplication().app, version: "1.0.0" });
  assert.deepEqual(JSON.parse(selected.stdout), [{ id: 7 }]);
}

export async function test_mutations_require_yes_and_dry_run_never_resolves_the_application(): Promise<void> {
  for (const argv of [
    ["tasks", "set", "7", "1.1", "working_on_it"],
    ["tasks", "submit", "7", "1.1", "--file", "/tmp/report.pdf"],
    ["chats", "send", "7", "1.1", "--message", "Hello"],
    ["chats", "mark-read", "7", "1.1"],
  ]) {
    const { app, calls } = fakeApplication();
    const rejected = await executeCli(argv, { app, version: "1.0.0", interactive: false });
    assert.equal(rejected.exitCode, 2, argv.join(" "));
    assert.deepEqual(calls, [], argv.join(" "));
    const dryRun = await executeCli([...argv, "--dry-run"], { app, version: "1.0.0", interactive: false });
    assert.equal(dryRun.exitCode, 0, argv.join(" "));
    assert.match(dryRun.stderr, /task|chat/i);
    assert.deepEqual(calls, [], argv.join(" "));
  }
}

export async function test_yes_executes_mutations_and_read_remains_non_mutating(): Promise<void> {
  const { app, calls } = fakeApplication();
  const sent = await executeCli(["chats", "send", "7", "1.1", "--message", "Hello", "--yes"], { app, version: "1.0.0", interactive: false });
  assert.equal(sent.exitCode, 0);
  assert.deepEqual(calls.map(({ name }) => name), ["prepareChatSend", "chatSend"]);
  calls.length = 0;
  const read = await executeCli(["tasks", "read", "7", "1.1"], { app, version: "1.0.0", interactive: false });
  assert.equal(read.stdout, "# Task\n");
  assert.deepEqual(calls.map(({ name }) => name), ["taskRead"]);
}

export async function test_errors_use_the_shared_vocabulary_exit_codes_and_one_rendering(): Promise<void> {
  const { app } = fakeApplication();
  const authApp: CliApplication = { ...app, user: async () => { throw new CliError("auth", "Session expired."); } };
  const auth = await executeCli(["user"], { app: authApp, version: "1.0.0" });
  assert.equal(auth.exitCode, 3);
  assert.deepEqual(JSON.parse(auth.stderr), {
    ok: false,
    error: { code: "auth", message: "Session expired." },
    exit_code: 3,
  });
  const usage = await executeCli(["task"], { app, version: "1.0.0" });
  assert.equal(usage.exitCode, 2);
  assert.equal(usage.stdout, "");
  assert.equal(usage.stderr.split("\n").filter((line) => line.includes("error")).length, 1);
}

export async function test_old_singular_command_groups_are_removed(): Promise<void> {
  const { app } = fakeApplication();
  for (const command of ["project", "task", "resources"]) {
    const result = await executeCli([command], { app, version: "1.0.0" });
    assert.equal(result.exitCode, 2);
  }
}
