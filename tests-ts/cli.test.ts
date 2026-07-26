import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { executeCli, type CliApplication } from "../src/cli-app.js";
import { CliError, errorCategories, exitCodeFor } from "../src/errors.js";

const secret = "ontrack_test_secret_SENTINEL_9d634c";

async function fixture(name: string): Promise<unknown> {
  const contents = await readFile(join(process.cwd(), "tests-ts", "fixtures", `${name}.json`), "utf8");
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

export async function test_command_flags_reach_the_application_seam(): Promise<void> {
  const { app, invocations } = await fakeApplication();
  await executeCli(["projects", "--include-inactive", "--json"], { app, version: "0.2.0" });
  await executeCli(["project", "7", "--json"], { app, version: "0.2.0" });
  await executeCli(["tasks", "7", "--status", "discuss", "--status", "rediscuss", "--json"], { app, version: "0.2.0" });
  await executeCli(["roles", "--all", "--json"], { app, version: "0.2.0" });

  assert.deepEqual(invocations, [
    { command: "projects", arguments: [{ includeInactive: true }] },
    { command: "project", arguments: [7] },
    { command: "tasks", arguments: [7, { statuses: ["discuss", "rediscuss"] }] },
    { command: "roles", arguments: [{ showAll: true }] },
  ]);
}

export async function test_yaml_is_a_usage_error_for_every_command(): Promise<void> {
  const commands = [
    ["user", "--yaml"],
    ["auth", "check", "--yaml"],
    ["projects", "--yaml"],
    ["project", "7", "--yaml"],
    ["tasks", "7", "--yaml"],
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
  const leaking: CliApplication = {
    ...app,
    user: async () => ({
      ...(await fixture("user") as Record<string, unknown>),
      authentication_token: secret,
      access_token: secret,
      nested: { refresh_token: secret },
    }),
  };
  const success = await executeCli(["user", "--json"], {
    app: leaking,
    version: "0.2.0",
    sensitiveValues: [secret],
  });
  assert.equal(success.exitCode, 0);
  assert.doesNotMatch(`${success.stdout}${success.stderr}`, new RegExp(secret));
  assert.equal(success.stdout, jsonText(await fixture("user")));

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
  for (const command of ["user", "auth", "projects", "project", "tasks", "roles"]) {
    assert.match(help.stdout, new RegExp(`\\b${command}\\b`));
  }

  const version = await executeCli(["--version"], { app, version: "0.2.0" });
  assert.deepEqual(version, { exitCode: 0, stdout: "ontrack 0.2.0\n", stderr: "" });
  assert.deepEqual(invocations, []);
}

export async function test_command_help_does_not_resolve_the_application(): Promise<void> {
  for (const argv of [["user", "--help"], ["auth", "check", "--help"], ["projects", "--help"], ["project", "--help"], ["tasks", "--help"], ["roles", "--help"]]) {
    const { app, invocations } = await fakeApplication();
    const result = await executeCli(argv, { app, version: "0.2.0" });
    assert.equal(result.exitCode, 0, argv.join(" "));
    assert.match(result.stdout, /^Usage: ontrack /, argv.join(" "));
    assert.equal(result.stderr, "", argv.join(" "));
    assert.deepEqual(invocations, [], argv.join(" "));
  }
}

export async function test_invalid_project_id_is_a_usage_error_before_application_work(): Promise<void> {
  const { app, invocations } = await fakeApplication();
  const result = await executeCli(["project", "not-an-id", "--json"], { app, version: "0.2.0" });
  assert.equal(result.exitCode, 2);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /project_id|integer/i);
  assert.deepEqual(invocations, []);
}
