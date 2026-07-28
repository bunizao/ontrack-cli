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
    user: await fixture("user"),
    authCheck: await fixture("auth-check"),
    projects: await fixture("projects"),
    project: await fixture("project"),
    tasks: await fixture("tasks"),
    resourcesDownload: { project_id: 7, unit_id: 9, archive_path: "/tmp/resources.zip", bytes_written: 4 },
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
      user: record("user", values.user),
      authCheck: record("authCheck", values.authCheck),
      projects: record("projects", values.projects),
      project: record("project", values.project),
      tasks: record("tasks", values.tasks),
      resourcesDownload: record("resourcesDownload", values.resourcesDownload),
      roles: record("roles", values.roles),
    },
    invocations,
  };
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
  await executeCli(["roles", "--all", "--json"], { app, version: "0.2.0" });

  assert.deepEqual(invocations, [
    { command: "projects", arguments: [{ includeInactive: true }] },
    { command: "project", arguments: [7] },
    { command: "tasks", arguments: [7, { statuses: ["discuss", "rediscuss"] }] },
    { command: "resourcesDownload", arguments: [7, { output: "resources.zip" }] },
    { command: "resourcesDownload", arguments: [8, {}] },
    { command: "roles", arguments: [{ showAll: true }] },
  ]);
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
    user: async () => expose(app.user()),
    authCheck: async () => expose(app.authCheck()),
    projects: async (options) => expose(app.projects(options)),
    project: async (projectId) => expose(app.project(projectId)),
    tasks: async (projectId, options) => expose(app.tasks(projectId, options)),
    resourcesDownload: async (projectId, options) => expose(app.resourcesDownload(projectId, options)),
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
      assert.match(success.stdout, /\[REDACTED\]/u, argv.join(" "));
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
  assert.match(help.stdout, /project arguments use the id from.*projects.*not list positions/is);

  const version = await executeCli(["--version"], { app, version: "0.2.0" });
  assert.deepEqual(version, { exitCode: 0, stdout: "ontrack 0.2.0\n", stderr: "" });
  assert.deepEqual(invocations, []);
}

export async function test_command_help_does_not_resolve_the_application(): Promise<void> {
  for (const argv of [["user", "--help"], ["auth", "check", "--help"], ["auth", "login", "--help"], ["projects", "--help"], ["project", "--help"], ["tasks", "--help"], ["resources", "download", "--help"], ["roles", "--help"]]) {
    const { app, invocations } = await fakeApplication();
    const result = await executeCli(argv, { app, version: "0.2.0" });
    assert.equal(result.exitCode, 0, argv.join(" "));
    assert.match(result.stdout, /^Usage: ontrack /, argv.join(" "));
    if (["project", "tasks", "resources"].includes(argv[0] ?? "")) {
      assert.match(result.stdout, /project arguments use the id from.*projects.*not list positions/is, argv.join(" "));
    }
    assert.equal(result.stderr, "", argv.join(" "));
    assert.deepEqual(invocations, [], argv.join(" "));
  }
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
