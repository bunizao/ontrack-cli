import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { executeCli, type CliApplication } from "../src/cli-app.js";
import { CliError, errorCategories, exitCodeFor } from "../src/errors.js";

const secret = "ontrack_test_secret_SENTINEL_9d634c";

async function fixture(name: string): Promise<unknown> {
  const contents = await readFile(join(process.cwd(), "tests", "fixtures", `${name}.json`), "utf8");
  return JSON.parse(contents) as unknown;
}

function jsonText(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

interface Invocation {
  readonly command: keyof CliApplication;
  readonly arguments: readonly unknown[];
}

async function fakeApplication(): Promise<{
  readonly app: CliApplication;
  readonly invocations: Invocation[];
}> {
  const values = {
    resolveProject: 7,
    user: await fixture("user"),
    authCheck: await fixture("auth-check"),
    projects: await fixture("projects"),
    project: await fixture("project"),
    tasks: await fixture("tasks"),
    resourcesDownload: { project_id: 7, unit_id: 9, archive_path: "/tmp/resources.zip", bytes_written: 4 },
    taskSheetDownload: { project_id: 7, unit_id: 9, task_definition_id: 12, task: "1.1", file_path: "/tmp/FIT9999-1.1.pdf", bytes_written: 6, content_type: "application/pdf" },
    taskResourcesDownload: { project_id: 7, unit_id: 9, task_definition_id: 12, task: "1.1", file_path: "/tmp/1.1-resources.zip", bytes_written: 4, content_type: "application/zip" },
    taskRead: { project_id: 7, unit_id: 9, task_definition_id: 12, task: "1.1", pages: 1, markdown: "# FIT9999 1.1 Task Sheet\n\nRead me.\n" },
    taskState: { project_id: 7, task_definition_id: 12, task: "1.1", previous_status: "not_started", status: "working_on_it" },
    prepareTaskSubmission: {
      projectId: 7,
      taskDefinitionId: 12,
      task: "1.1",
      previousStatus: "working_on_it",
      type: "ready_for_feedback",
      acceptTiiEula: false,
      uploads: [{ key: "file0", requirementName: "Report", requirementType: "document", path: "/tmp/report.pdf", filename: "report.pdf", contentType: "application/pdf", bytes: new Uint8Array([1]) }],
    },
    submitTask: { project_id: 7, task_definition_id: 12, task: "1.1", previous_status: "working_on_it", status: "ready_for_feedback", submission_type: "ready_for_feedback", processing_async: true },
    chatsSummary: [{ task_definition_id: 12, task: "1.1", name: "Example task", status: "rediscuss", unread_comments: 2 }],
    chatsHistory: await fixture("chats"),
    chatSend: { project_id: 7, task_definition_id: 12, task: "1.1", comment_id: 51, message: "Please review this.", created_at: "2026-07-28T03:04:05.000Z" },
    roles: await fixture("roles"),
  };
  const invocations: Invocation[] = [];
  const record = <Name extends keyof CliApplication>(name: Name, value: unknown) =>
    async (...arguments_: unknown[]): Promise<unknown> => {
      invocations.push({ command: name, arguments: arguments_ });
      return value;
    };

  return {
    app: {
      resolveProject: record("resolveProject", values.resolveProject) as CliApplication["resolveProject"],
      user: record("user", values.user),
      authCheck: record("authCheck", values.authCheck),
      projects: record("projects", values.projects),
      project: record("project", values.project),
      tasks: record("tasks", values.tasks),
      resourcesDownload: record("resourcesDownload", values.resourcesDownload),
      taskSheetDownload: record("taskSheetDownload", values.taskSheetDownload),
      taskResourcesDownload: record("taskResourcesDownload", values.taskResourcesDownload),
      taskRead: record("taskRead", values.taskRead),
      taskState: record("taskState", values.taskState),
      prepareTaskSubmission: record("prepareTaskSubmission", values.prepareTaskSubmission) as CliApplication["prepareTaskSubmission"],
      submitTask: record("submitTask", values.submitTask) as CliApplication["submitTask"],
      chats: async (projectId, options) => record("chats", options.task ? values.chatsHistory : values.chatsSummary)(projectId, options),
      chatSend: record("chatSend", values.chatSend),
      roles: record("roles", values.roles),
    },
    invocations,
  };
}

export async function test_chat_send_requires_confirmation_before_application_work(): Promise<void> {
  const { app, invocations } = await fakeApplication();
  const refused = await executeCli(["chats", "send", "7", "1.1", "--message", "Please review this."], {
    app,
    version: "0.2.0",
  });
  assert.equal(refused.exitCode, 2);
  assert.match(refused.stderr, /confirmation.*--yes/i);
  assert.deepEqual(invocations, []);

  const confirmations: unknown[] = [];
  const confirmed = await executeCli(["chats", "send", "7", "1.1", "--message", "Please review this."], {
    app,
    version: "0.2.0",
    confirmChatSend: async (details) => {
      confirmations.push(details);
      return true;
    },
  });
  assert.deepEqual(confirmations, [{ projectId: 7, task: "1.1", message: "Please review this." }]);
  assert.deepEqual(invocations, [{ command: "chatSend", arguments: [7, "1.1", "Please review this."] }]);
  assert.equal(confirmed.exitCode, 0);
  assert.match(confirmed.stdout, /Project\s+Task\s+Comment ID\s+Time\s+Message/u);
}

export async function test_task_submit_requires_confirmation_and_never_mutates_when_declined(): Promise<void> {
  const { app, invocations } = await fakeApplication();
  const refused = await executeCli(["task", "submit", "FIT1045", "1.1", "--file", "/tmp/report.pdf"], {
    app,
    version: "0.2.0",
  });
  assert.equal(refused.exitCode, 2);
  assert.match(refused.stderr, /confirmation.*--yes/iu);
  assert.deepEqual(invocations, []);

  const declined = await executeCli(["task", "submit", "FIT1045", "1.1", "--file", "/tmp/report.pdf"], {
    app,
    version: "0.2.0",
    confirmTaskSubmit: async () => false,
  });
  assert.equal(declined.exitCode, 2);
  assert.deepEqual(invocations.map(({ command }) => command), ["resolveProject", "prepareTaskSubmission"]);
  assert.equal(invocations.some(({ command }) => command === "submitTask"), false);
}

export async function test_task_submit_yes_preserves_file_order_and_submission_type(): Promise<void> {
  const { app, invocations } = await fakeApplication();
  const result = await executeCli([
    "task", "submit", "7", "1.1",
    "--file", "/tmp/report.pdf",
    "--type", "ready_for_feedback",
    "--comment", "Please review",
    "--yes",
    "--json",
  ], { app, version: "0.2.0" });

  assert.equal(result.exitCode, 0);
  assert.equal(JSON.parse(result.stdout).processing_async, true);
  assert.deepEqual(invocations[0], {
    command: "prepareTaskSubmission",
    arguments: [7, "1.1", { files: ["/tmp/report.pdf"], type: "ready_for_feedback", acceptTiiEula: false, comment: "Please review" }],
  });
  assert.equal(invocations[1]?.command, "submitTask");
}

export async function test_task_submit_rejects_invalid_options_before_application_work(): Promise<void> {
  for (const argv of [
    ["task", "submit", "7", "1.1", "--file", "/tmp/report.pdf", "--type", "working_on_it", "--yes"],
    ["task", "submit", "7", "1.1", "--file", "/tmp/report.pdf", "--comment", "x".repeat(4096), "--yes"],
  ]) {
    const { app, invocations } = await fakeApplication();
    const result = await executeCli(argv, { app, version: "0.2.0" });
    assert.equal(result.exitCode, 2);
    assert.deepEqual(invocations, []);
  }
}

export async function test_chat_send_yes_is_explicit_noninteractive_confirmation(): Promise<void> {
  const { app, invocations } = await fakeApplication();
  const result = await executeCli(["chats", "send", "7", "1.1", "--message", "Please review this.", "-y", "--json"], {
    app,
    version: "0.2.0",
  });
  assert.equal(result.exitCode, 0);
  assert.deepEqual(JSON.parse(result.stdout), {
    project_id: 7,
    task_definition_id: 12,
    task: "1.1",
    comment_id: 51,
    message: "Please review this.",
    created_at: "2026-07-28T03:04:05.000Z",
  });
  assert.deepEqual(invocations, [{ command: "chatSend", arguments: [7, "1.1", "Please review this."] }]);
}

export async function test_chat_send_does_not_mutate_when_typed_confirmation_is_declined(): Promise<void> {
  const { app, invocations } = await fakeApplication();
  const result = await executeCli(["chats", "send", "7", "1.1", "--message", "Please review this."], {
    app,
    version: "0.2.0",
    confirmChatSend: async () => false,
  });
  assert.equal(result.exitCode, 2);
  assert.match(result.stderr, /not confirmed/i);
  assert.deepEqual(invocations, []);
}

export async function test_chat_send_rejects_invalid_messages_before_confirmation(): Promise<void> {
  const { app, invocations } = await fakeApplication();
  let confirmations = 0;
  for (const message of ["", " ", "x".repeat(4096)]) {
    const result = await executeCli(["chats", "send", "7", "1.1", "--message", message], {
      app,
      version: "0.2.0",
      confirmChatSend: async () => {
        confirmations += 1;
        return true;
      },
    });
    assert.equal(result.exitCode, 2, String(message.length));
  }
  assert.equal(confirmations, 0);
  assert.deepEqual(invocations, []);
}

export async function test_six_existing_commands_emit_stable_json(): Promise<void> {
  const cases = [
    { argv: ["user", "--json"], fixture: "user", command: "user" },
    { argv: ["auth", "check", "--json"], fixture: "auth-check", command: "authCheck" },
    { argv: ["projects", "--include-inactive", "--json"], fixture: "projects", command: "projects" },
    { argv: ["project", "7", "--json"], fixture: "project", command: "project" },
    { argv: ["tasks", "7", "--status", "rediscuss", "--status", "discuss", "--json"], fixture: "tasks", command: "tasks" },
    { argv: ["roles", "--all", "--json"], fixture: "roles", command: "roles" },
  ] as const;

  for (const testCase of cases) {
    const { app, invocations } = await fakeApplication();
    const result = await executeCli(testCase.argv, { app, version: "0.2.0" });
    assert.equal(result.exitCode, 0, testCase.command);
    assert.equal(result.stdout, jsonText(await fixture(testCase.fixture)), testCase.command);
    assert.equal(result.stderr, "", testCase.command);
    assert.deepEqual(JSON.parse(result.stdout), await fixture(testCase.fixture), testCase.command);
    assert.equal(invocations.length, 1, testCase.command);
    assert.equal(invocations[0]?.command, testCase.command, testCase.command);
  }
}

export async function test_auth_login_is_an_explicit_cli_command_with_sanitized_json(): Promise<void> {
  const { app, invocations } = await fakeApplication();
  let loginCalls = 0;
  const result = await executeCli(["auth", "login", "--json"], {
    app,
    version: "0.2.0",
    authLogin: async () => {
      loginCalls += 1;
      return { username: "alice", auth_token_expiry: "2030-01-01T00:00:00.000Z" };
    },
  });
  assert.deepEqual(result, {
    exitCode: 0,
    stdout: jsonText({ username: "alice", auth_token_expiry: "2030-01-01T00:00:00.000Z" }),
    stderr: "",
  });
  assert.equal(loginCalls, 1);
  assert.deepEqual(invocations, []);
}

export async function test_command_flags_reach_the_application_seam(): Promise<void> {
  const { app, invocations } = await fakeApplication();
  await executeCli(["projects", "--include-inactive", "--json"], { app, version: "0.2.0" });
  await executeCli(["project", "7", "--json"], { app, version: "0.2.0" });
  await executeCli(["tasks", "7", "--status", "discuss", "--status", "rediscuss", "--json"], { app, version: "0.2.0" });
  await executeCli(["resources", "download", "7", "--output", "resources.zip", "--json"], { app, version: "0.2.0" });
  await executeCli(["resources", "download", "8", "--json"], { app, version: "0.2.0" });
  await executeCli(["task", "sheet", "7", "1.1", "--output", "sheet.pdf", "--json"], { app, version: "0.2.0" });
  await executeCli(["task", "resources", "7", "1.1", "--json"], { app, version: "0.2.0" });
  await executeCli(["task", "read", "7", "1.1"], { app, version: "0.2.0" });
  await executeCli(["chats", "7", "--json"], { app, version: "0.2.0" });
  await executeCli(["chats", "7", "1.1", "--json"], { app, version: "0.2.0" });
  await executeCli(["roles", "--all", "--json"], { app, version: "0.2.0" });

  assert.deepEqual(invocations, [
    { command: "projects", arguments: [{ includeInactive: true }] },
    { command: "project", arguments: [7] },
    { command: "tasks", arguments: [7, { statuses: ["discuss", "rediscuss"] }] },
    { command: "resourcesDownload", arguments: [7, { output: "resources.zip" }] },
    { command: "resourcesDownload", arguments: [8, {}] },
    { command: "taskSheetDownload", arguments: [7, "1.1", { output: "sheet.pdf" }] },
    { command: "taskResourcesDownload", arguments: [7, "1.1", {}] },
    { command: "taskRead", arguments: [7, "1.1"] },
    { command: "chats", arguments: [7, {}] },
    { command: "chats", arguments: [7, { task: "1.1" }] },
    { command: "roles", arguments: [{ showAll: true }] },
  ]);
}

export async function test_unit_code_resolves_before_every_project_scoped_command(): Promise<void> {
  const cases: Array<{ readonly argv: string[]; readonly command: keyof CliApplication }> = [
    { argv: ["project", "fit1045", "--json"], command: "project" },
    { argv: ["tasks", "FIT1045", "--json"], command: "tasks" },
    { argv: ["resources", "download", "FIT1045", "--json"], command: "resourcesDownload" },
    { argv: ["task", "sheet", "FIT1045", "1.1", "--json"], command: "taskSheetDownload" },
    { argv: ["task", "resources", "FIT1045", "1.1", "--json"], command: "taskResourcesDownload" },
    { argv: ["task", "read", "FIT1045", "1.1", "--json"], command: "taskRead" },
    { argv: ["task", "state", "FIT1045", "1.1", "working_on_it", "--json"], command: "taskState" },
    { argv: ["task", "submit", "FIT1045", "1.1", "--file", "/tmp/report.pdf", "--yes", "--json"], command: "prepareTaskSubmission" },
    { argv: ["chats", "FIT1045", "--json"], command: "chats" },
    { argv: ["chats", "send", "FIT1045", "1.1", "--message", "Hello", "--yes", "--json"], command: "chatSend" },
  ];
  for (const { argv, command } of cases) {
    const { app, invocations } = await fakeApplication();
    const result = await executeCli(argv, { app, version: "0.2.0" });
    assert.equal(result.exitCode, 0, argv.join(" "));
    assert.deepEqual(invocations[0], { command: "resolveProject", arguments: [argv.includes("fit1045") ? "fit1045" : "FIT1045"] });
    assert.equal(invocations.some((invocation) => invocation.command === command), true, command);
  }
}

export async function test_task_state_updates_one_task_without_submission_confirmation(): Promise<void> {
  const { app, invocations } = await fakeApplication();
  const result = await executeCli(["task", "state", "7", "1.1", "working_on_it", "--json"], { app, version: "0.2.0" });

  assert.equal(result.exitCode, 0);
  assert.equal(result.stderr, "");
  assert.deepEqual(invocations, [{ command: "taskState", arguments: [7, "1.1", "working_on_it"] }]);
}

export async function test_yaml_is_a_usage_error_for_every_command(): Promise<void> {
  const commands = [
    ["user", "--yaml"],
    ["auth", "check", "--yaml"],
    ["auth", "login", "--yaml"],
    ["projects", "--yaml"],
    ["project", "7", "--yaml"],
    ["tasks", "7", "--yaml"],
    ["resources", "download", "7", "--yaml"],
    ["task", "sheet", "7", "1.1", "--yaml"],
    ["task", "resources", "7", "1.1", "--yaml"],
    ["task", "read", "7", "1.1", "--yaml"],
    ["chats", "7", "--yaml"],
    ["chats", "send", "7", "1.1", "--message", "Hello", "--yaml"],
    ["roles", "--yaml"],
  ];

  for (const argv of commands) {
    const { app, invocations } = await fakeApplication();
    const result = await executeCli(argv, { app, version: "0.2.0" });
    assert.equal(result.exitCode, 2, argv.join(" "));
    assert.equal(result.stdout, "", argv.join(" "));
    assert.match(result.stderr, /unknown option.*--yaml|--yaml.*unknown option/i, argv.join(" "));
    assert.deepEqual(invocations, [], argv.join(" "));
  }
}

export async function test_failures_use_stable_exit_codes_and_never_write_stdout(): Promise<void> {
  for (const category of errorCategories) {
    const { app } = await fakeApplication();
    const failing: CliApplication = {
      ...app,
      projects: async () => { throw new CliError(category, `${category} failure`); },
    };
    const result = await executeCli(["projects", "--json"], { app: failing, version: "0.2.0" });
    assert.equal(result.exitCode, exitCodeFor(category), category);
    assert.equal(result.stdout, "", category);
    assert.match(result.stderr, new RegExp(category.replace("_", "[ _]"), "i"), category);
    assert.doesNotMatch(result.stderr, /\n\s+at\s/u, category);
  }
}

export async function test_secret_sentinel_is_removed_from_results_and_diagnostics(): Promise<void> {
  const { app } = await fakeApplication();
  const expose = async (value: Promise<unknown>): Promise<unknown> => ({
    marker: secret,
    auth_token: secret,
    result: await value,
  });
  const leaking: CliApplication = {
    resolveProject: async (reference) => app.resolveProject(reference),
    user: async () => expose(app.user()),
    authCheck: async () => expose(app.authCheck()),
    projects: async (options) => expose(app.projects(options)),
    project: async (projectId) => expose(app.project(projectId)),
    tasks: async (projectId, options) => expose(app.tasks(projectId, options)),
    resourcesDownload: async (projectId, options) => expose(app.resourcesDownload(projectId, options)),
    taskSheetDownload: async (projectId, task, options) => expose(app.taskSheetDownload(projectId, task, options)),
    taskResourcesDownload: async (projectId, task, options) => expose(app.taskResourcesDownload(projectId, task, options)),
    taskRead: async (projectId, task) => expose(app.taskRead(projectId, task)),
    taskState: async (projectId, task, state) => expose(app.taskState(projectId, task, state)),
    prepareTaskSubmission: async (projectId, task, options) => app.prepareTaskSubmission(projectId, task, options),
    submitTask: async (plan) => expose(app.submitTask(plan)),
    chats: async (projectId, options) => expose(app.chats(projectId, options)),
    chatSend: async (projectId, task, message) => expose(app.chatSend(projectId, task, message)),
    roles: async (options) => expose(app.roles(options)),
  };
  const commands = [
    ["user"],
    ["auth", "check"],
    ["auth", "login"],
    ["projects"],
    ["project", "7"],
    ["tasks", "7"],
    ["resources", "download", "7"],
    ["task", "sheet", "7", "1.1"],
    ["task", "resources", "7", "1.1"],
    ["task", "read", "7", "1.1"],
    ["chats", "7"],
    ["roles"],
  ];
  for (const command of commands) {
    for (const json of [false, true]) {
      const argv = json ? [...command, "--json"] : command;
      const success = await executeCli(argv, {
        app: leaking,
        version: "0.2.0",
        sensitiveValues: [secret],
        authLogin: async () => expose(Promise.resolve({ username: "alice" })),
      });
      assert.equal(success.exitCode, 0, argv.join(" "));
      assert.doesNotMatch(`${success.stdout}${success.stderr}`, new RegExp(secret), argv.join(" "));
      if (json) assert.match(success.stdout, /\[REDACTED\]/u, argv.join(" "));
      assert.doesNotMatch(success.stdout, /auth_token/u, argv.join(" "));
    }
  }

  const diagnostic: CliApplication = {
    ...app,
    user: async () => { throw new CliError("auth", `Rejected token ${secret}`); },
  };
  const failure = await executeCli(["user", "--json"], {
    app: diagnostic,
    version: "0.2.0",
    sensitiveValues: [secret],
  });
  assert.equal(failure.exitCode, 1);
  assert.equal(failure.stdout, "");
  assert.doesNotMatch(failure.stderr, new RegExp(secret));
}

export async function test_help_and_version_succeed_without_resolving_the_application(): Promise<void> {
  const { app, invocations } = await fakeApplication();
  const help = await executeCli(["--help"], { app, version: "0.2.0" });
  assert.equal(help.exitCode, 0);
  assert.equal(help.stderr, "");
  assert.match(help.stdout, /^Usage: ontrack /);
  for (const command of ["user", "auth", "projects", "project", "tasks", "resources", "roles"]) {
    assert.match(help.stdout, new RegExp(`\\b${command}\\b`));
  }
  assert.match(help.stdout, /project arguments accept.*unit code.*ID from.*projects/is);

  const version = await executeCli(["--version"], { app, version: "0.2.0" });
  assert.deepEqual(version, { exitCode: 0, stdout: "ontrack 0.2.0\n", stderr: "" });
  assert.deepEqual(invocations, []);
}

export async function test_command_help_does_not_resolve_the_application(): Promise<void> {
  const cases = [
    { argv: ["user", "--help"], usage: "ontrack user", option: "--json" },
    { argv: ["auth", "check", "--help"], usage: "ontrack auth check", option: "--json" },
    { argv: ["auth", "login", "--help"], usage: "ontrack auth login", option: "--json" },
    { argv: ["projects", "--help"], usage: "ontrack projects", option: "--include-inactive" },
    { argv: ["project", "--help"], usage: "ontrack project <project>", option: "unit code" },
    { argv: ["tasks", "--help"], usage: "ontrack tasks <project>", option: "--status" },
    { argv: ["resources", "download", "--help"], usage: "ontrack resources download <project>", option: "--output" },
    { argv: ["task", "sheet", "--help"], usage: "ontrack task sheet <project> <task>", option: "--output" },
    { argv: ["task", "resources", "--help"], usage: "ontrack task resources <project> <task>", option: "--output" },
    { argv: ["task", "read", "--help"], usage: "ontrack task read <project> <task>", option: "Markdown" },
    { argv: ["task", "state", "--help"], usage: "ontrack task state <project> <task> <state>", option: "working_on_it" },
    { argv: ["task", "submit", "--help"], usage: "ontrack task submit <project> <task>", option: "--file" },
    { argv: ["chats", "--help"], usage: "ontrack chats <project> [task]", option: "marks" },
    { argv: ["chats", "send", "--help"], usage: "ontrack chats send <project> <task>", option: "--message" },
    { argv: ["roles", "--help"], usage: "ontrack roles", option: "--all" },
  ];
  for (const { argv, usage, option } of cases) {
    const { app, invocations } = await fakeApplication();
    const result = await executeCli(argv, { app, version: "0.2.0" });
    assert.equal(result.exitCode, 0, argv.join(" "));
    assert.match(result.stdout, new RegExp(`^Usage: ${usage.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "u"), argv.join(" "));
    assert.match(result.stdout, new RegExp(option.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "iu"), argv.join(" "));
    assert.equal(result.stderr, "", argv.join(" "));
    assert.deepEqual(invocations, [], argv.join(" "));
  }
}

export async function test_bare_root_and_groups_show_discoverable_help(): Promise<void> {
  const { app, invocations } = await fakeApplication();
  for (const { argv, pattern } of [
    { argv: [] as string[], pattern: /Usage: ontrack <command>/u },
    { argv: ["auth"], pattern: /Usage: ontrack auth <command>/u },
    { argv: ["resources"], pattern: /Usage: ontrack resources <command>/u },
  ]) {
    const result = await executeCli(argv, { app, version: "0.2.0" });
    assert.equal(result.exitCode, 0, argv.join(" "));
    assert.match(result.stdout, pattern, argv.join(" "));
    assert.equal(result.stderr, "", argv.join(" "));
  }
  assert.deepEqual(invocations, []);
}

export async function test_default_output_uses_command_aware_tables(): Promise<void> {
  const cases = [
    { argv: ["projects"], headers: /ID\s+Unit\s+Name\s+Role\s+Start\s+End\s+Active/u },
    { argv: ["tasks", "7"], headers: /Task\s+Name\s+Status\s+Due\s+Grade\s+Quality\s+Overdue/u },
    { argv: ["roles"], headers: /Unit\s+Name\s+Role\s+User/u },
    { argv: ["project", "7"], headers: /Field\s+Value[\s\S]*Project ID\s+7[\s\S]*Tasks[\s\S]*No project tasks found/u },
    { argv: ["resources", "download", "7"], headers: /Project\s+Unit\s+Archive\s+Size/u },
    { argv: ["task", "sheet", "7", "1.1"], headers: /Project\s+Unit\s+Task\s+File\s+Size/u },
    { argv: ["task", "resources", "7", "1.1"], headers: /Project\s+Unit\s+Task\s+File\s+Size/u },
    { argv: ["task", "state", "7", "1.1", "working_on_it"], headers: /Field\s+Value[\s\S]*previous_status[\s\S]*working_on_it/u },
    { argv: ["task", "submit", "7", "1.1", "--file", "/tmp/report.pdf", "--yes"], headers: /Field\s+Value[\s\S]*Processing asynchronously\s+Yes/u },
    { argv: ["chats", "7"], headers: /Task\s+Name\s+Status\s+Unread/u },
  ];
  for (const { argv, headers } of cases) {
    const { app } = await fakeApplication();
    const result = await executeCli(argv, { app, version: "0.2.0" });
    assert.equal(result.exitCode, 0, argv.join(" "));
    assert.match(result.stdout, headers, argv.join(" "));
    assert.doesNotMatch(result.stdout, /\{"id":/u, argv.join(" "));
    assert.equal(result.stderr, "", argv.join(" "));
  }
}

export async function test_project_table_lists_downloadable_unit_tasks_when_no_project_tasks_exist(): Promise<void> {
  const { app } = await fakeApplication();
  const projectApp: CliApplication = {
    ...app,
    project: async () => ({
      project: { id: 7, target_grade: 3 },
      unit: {
        summary: { code: "FIT9999", name: "Example Unit" },
        task_definitions: [{ id: 12, abbreviation: "P1", name: "Search task" }],
      },
      tasks: [],
    }),
  };
  const result = await executeCli(["project", "7"], { app: projectApp, version: "0.2.0" });
  assert.match(result.stdout, /No project tasks found/u);
  assert.match(result.stdout, /Available unit tasks[\s\S]*Task\s+Name[\s\S]*P1\s+Search task/u);
}

export async function test_task_read_prints_markdown_directly_for_agents(): Promise<void> {
  const { app } = await fakeApplication();
  const result = await executeCli(["task", "read", "7", "1.1"], { app, version: "0.2.0" });
  assert.deepEqual(result, {
    exitCode: 0,
    stdout: "# FIT9999 1.1 Task Sheet\n\nRead me.\n",
    stderr: "",
  });
}

export async function test_chat_history_is_a_table_with_an_explicit_read_side_effect_note(): Promise<void> {
  const { app } = await fakeApplication();
  const result = await executeCli(["chats", "7", "1.1"], { app, version: "0.2.0" });
  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /Time\s+Author\s+Type\s+Message\s+Attachment\s+Reply To/u);
  assert.match(result.stdout, /Example Tutor/u);
  assert.doesNotMatch(result.stdout, /@example\.invalid/u);
  assert.match(result.stderr, /marks.*read/i);
}

export async function test_chat_json_remains_machine_clean_while_warning_stays_on_stderr(): Promise<void> {
  const { app } = await fakeApplication();
  const result = await executeCli(["chats", "7", "1.1", "--json"], { app, version: "0.2.0" });
  assert.deepEqual(JSON.parse(result.stdout), await fixture("chats"));
  assert.match(result.stderr, /marks.*read/i);
}

export async function test_chat_warning_is_emitted_before_history_is_requested(): Promise<void> {
  const { app } = await fakeApplication();
  const events: string[] = [];
  const observing: CliApplication = {
    ...app,
    chats: async () => {
      events.push("request");
      return [];
    },
  };
  const result = await executeCli(["chats", "7", "1.1"], {
    app: observing,
    version: "0.2.0",
    onDiagnostic: () => { events.push("warning"); },
  });
  assert.deepEqual(events, ["warning", "request"]);
  assert.equal(result.stderr, "");
}

export async function test_chat_table_bounds_long_messages_and_removes_terminal_controls(): Promise<void> {
  const { app } = await fakeApplication();
  const longMessage = `first line\n\u001b[31m${"x".repeat(200)}\u001b[0m`;
  const chatApp: CliApplication = {
    ...app,
    chats: async () => [{
      id: 1,
      comment: longMessage,
      has_attachment: false,
      type: "text",
      is_new: false,
      reply_to_id: null,
      author: { first_name: "Example", last_name: "Tutor" },
      created_at: "2026-07-28T01:02:03.000Z",
    }],
  };
  const result = await executeCli(["chats", "7", "1.1"], { app: chatApp, version: "0.2.0" });
  assert.doesNotMatch(result.stdout, /\u001b|\nfirst line\n/u);
  assert.match(result.stdout, /first line x{20,}\.\.\./u);
  assert.doesNotMatch(result.stdout, /x{118}/u);
}

export async function test_empty_default_tables_explain_the_result(): Promise<void> {
  const { app } = await fakeApplication();
  const empty: CliApplication = {
    ...app,
    projects: async () => [],
    tasks: async () => [],
    roles: async () => [],
  };
  assert.equal((await executeCli(["projects"], { app: empty, version: "0.2.0" })).stdout,
    "No active projects found. Use --include-inactive to include past projects.\n");
  assert.equal((await executeCli(["projects", "--include-inactive"], { app: empty, version: "0.2.0" })).stdout,
    "No projects found.\n");
  assert.equal((await executeCli(["tasks", "7"], { app: empty, version: "0.2.0" })).stdout,
    "No tasks found.\n");
  assert.equal((await executeCli(["tasks", "7", "--status", "rediscuss"], { app: empty, version: "0.2.0" })).stdout,
    "No tasks match status: rediscuss.\n");
  assert.equal((await executeCli(["roles"], { app: empty, version: "0.2.0" })).stdout,
    "No active teaching roles found. Use --all to include inactive roles.\n");
  assert.equal((await executeCli(["roles", "--all"], { app: empty, version: "0.2.0" })).stdout,
    "No teaching roles found.\n");
}

export async function test_unknown_command_with_help_remains_a_usage_error(): Promise<void> {
  const { app, invocations } = await fakeApplication();
  const result = await executeCli(["unknown", "--help"], { app, version: "0.2.0" });
  assert.equal(result.exitCode, 2);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /unknown command/i);
  assert.deepEqual(invocations, []);
}

export async function test_invalid_project_id_is_a_usage_error_before_application_work(): Promise<void> {
  const { app, invocations } = await fakeApplication();
  for (const value of ["not-an-id", "0", "9007199254740992"]) {
    const result = await executeCli(["project", value, "--json"], { app, version: "0.2.0" });
    assert.equal(result.exitCode, 2);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /project_id|integer/i);
  }
  assert.deepEqual(invocations, []);
}

export async function test_resource_download_rejects_invalid_arguments_before_application_work(): Promise<void> {
  const { app, invocations } = await fakeApplication();
  for (const argv of [
    ["resources", "download", "not-an-id", "--json"],
    ["resources", "download", "7", "--output", "", "--json"],
    ["resources", "download", "7", "extra", "--json"],
  ]) {
    const result = await executeCli(argv, { app, version: "0.2.0" });
    assert.equal(result.exitCode, 2, argv.join(" "));
    assert.equal(result.stdout, "", argv.join(" "));
  }
  assert.deepEqual(invocations, []);
}

export async function test_task_downloads_reject_invalid_arguments_before_application_work(): Promise<void> {
  const { app, invocations } = await fakeApplication();
  for (const argv of [
    ["task", "sheet", "7"],
    ["task", "sheet", "7", "", "--json"],
    ["task", "resources", "bad-id", "1.1", "--json"],
    ["task", "resources", "7", "1.1", "--output", "", "--json"],
    ["task", "read", "7"],
    ["task", "read", "7", ""],
    ["task", "read", "7", "1.1", "extra"],
  ]) {
    const result = await executeCli(argv, { app, version: "0.2.0" });
    assert.equal(result.exitCode, 2, argv.join(" "));
    assert.equal(result.stdout, "", argv.join(" "));
  }
  assert.deepEqual(invocations, []);
}
