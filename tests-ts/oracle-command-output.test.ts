import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";

const importer = join(process.cwd(), "scripts", "golden-import-command-output.mjs");
const verifier = join(process.cwd(), "scripts", "golden-verify-oracle.mjs");
const replayHarness = join(process.cwd(), "scripts", "python-replay-sitecustomize.py");
const oracleCommit = (JSON.parse(await readFile(join(process.cwd(), "tests", "golden", "oracle-provenance.json"), "utf8")) as { readonly python_release_commit: string }).python_release_commit;

interface FixtureWorkspace {
  readonly directory: string;
  readonly sourceDirectory: string;
  readonly caseDirectory: string;
  readonly stdoutCapture: string;
  readonly replayProvenance: string;
  readonly caseName: string;
}

async function jsonFile<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

async function fixtureWorkspace(
  stdout = "[]\n",
  goldenStdout = stdout,
  caseName = "projects/current-json",
  argv: readonly string[] = ["projects", "--json"],
  env: Readonly<Record<string, string>> = {},
): Promise<FixtureWorkspace> {
  const directory = await mkdtemp(join(tmpdir(), "ontrack-command-oracle-"));
  const sourceDirectory = join(directory, "tests", "golden", "sources", "oracle-test");
  const caseDirectory = join(directory, "tests", "golden", ...caseName.split("/"));
  await Promise.all([
    mkdir(sourceDirectory, { recursive: true }),
    mkdir(caseDirectory, { recursive: true }),
    mkdir(join(directory, "scripts"), { recursive: true }),
  ]);
  const fixture = "[]\n";
  const session = `${JSON.stringify({
    base_url: "https://school.example.invalid",
    username: "recorded-user",
  }, null, 2)}\n`;
  await Promise.all([
    writeFile(join(sourceDirectory, "http.json"), fixture, "utf8"),
    writeFile(join(sourceDirectory, "session.json"), session, "utf8"),
    writeFile(join(sourceDirectory, "source.json"), `${JSON.stringify({
      schema: 1,
      kind: "python_oracle",
      live_recorded: true,
      description: "Test oracle source",
      fixture: "http.json",
      session: "session.json",
      oracle_commit: oracleCommit,
      recorded_at: "2026-07-26T12:00:00.000Z",
      capture_sha256: createHash("sha256").update(fixture).digest("hex"),
    }, null, 2)}\n`, "utf8"),
    writeFile(join(caseDirectory, "argv"), `${JSON.stringify(argv)}\n`, "utf8"),
    writeFile(join(caseDirectory, "env"), `${JSON.stringify(env)}\n`, "utf8"),
    writeFile(join(caseDirectory, "exit"), "0\n", "utf8"),
    writeFile(join(caseDirectory, "source.json"), "{\"id\":\"oracle-test\"}\n", "utf8"),
    writeFile(join(caseDirectory, "stderr.txt"), "", "utf8"),
    writeFile(join(caseDirectory, "stdout.json"), goldenStdout, "utf8"),
    writeFile(join(directory, "tests", "golden", "oracle-required-cases.json"), `${JSON.stringify({ [caseName]: argv }, null, 2)}\n`, "utf8"),
    writeFile(join(directory, "scripts", "python-replay-sitecustomize.py"), await readFile(replayHarness), "utf8"),
  ]);
  const stdoutCapture = join(directory, "python-stdout.json");
  const replayProvenance = join(directory, "replay-provenance.json");
  await Promise.all([
    writeFile(stdoutCapture, stdout, "utf8"),
    writeFile(replayProvenance, `${JSON.stringify({
      schema: 1,
      kind: "python_fixture_replay",
      python_commit: oracleCommit,
      entrypoint: "ontrack_cli.cli",
      fixture_sha256: createHash("sha256").update(fixture).digest("hex"),
      session_sha256: createHash("sha256").update(session).digest("hex"),
      replay_harness_sha256: createHash("sha256").update(await readFile(replayHarness)).digest("hex"),
      argv,
      env_allowlist: Object.keys(env).sort(),
      env: Object.fromEntries(Object.entries(env).sort(([left], [right]) => left.localeCompare(right))),
      stdout_sha256: createHash("sha256").update(stdout).digest("hex"),
      stderr_sha256: createHash("sha256").update("").digest("hex"),
      exit: 0,
    }, null, 2)}\n`, "utf8"),
  ]);
  for (const command of [
    ["init", "--quiet"],
    ["add", "tests", "scripts"],
    [
      "-c", "user.name=Oracle Test",
      "-c", "user.email=oracle@example.invalid",
      "-c", "commit.gpgsign=false",
      "commit", "--quiet", "-m", "test: seed golden",
    ],
  ]) {
    const result = spawnSync("git", command, { cwd: directory, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
  }
  const replay = await jsonFile<Record<string, unknown>>(replayProvenance);
  const toolCommit = spawnSync("git", ["rev-parse", "HEAD"], { cwd: directory, encoding: "utf8" }).stdout.trim();
  await writeFile(replayProvenance, `${JSON.stringify({ ...replay, replay_tool_commit: toolCommit }, null, 2)}\n`, "utf8");
  return { directory, sourceDirectory, caseDirectory, stdoutCapture, replayProvenance, caseName };
}

function importOutput(workspace: FixtureWorkspace): SpawnSyncReturns<string> {
  return spawnSync(process.execPath, [
    importer,
    workspace.stdoutCapture,
    "--replay-provenance",
    workspace.replayProvenance,
    "oracle-test",
    workspace.caseName,
    "2026-07-26T12:01:00Z",
    "--confirm-reproducible-python-replay",
  ], { cwd: workspace.directory, encoding: "utf8" });
}

function verify(workspace: FixtureWorkspace): SpawnSyncReturns<string> {
  return spawnSync(process.execPath, [verifier], { cwd: workspace.directory, encoding: "utf8" });
}

async function bindCaseToSyntheticSource(workspace: FixtureWorkspace): Promise<void> {
  const syntheticDirectory = join(workspace.directory, "tests", "golden", "sources", "synthetic-test");
  await mkdir(syntheticDirectory, { recursive: true });
  await Promise.all([
    writeFile(join(syntheticDirectory, "source.json"), `${JSON.stringify({
      schema: 1,
      kind: "synthetic",
      live_recorded: false,
      description: "Synthetic test baseline",
      fixture: "http.json",
      session: "session.json",
    }, null, 2)}\n`, "utf8"),
    writeFile(join(workspace.caseDirectory, "source.json"), "{\"id\":\"synthetic-test\"}\n", "utf8"),
  ]);
}

export async function test_command_output_import_binds_python_bytes_to_source_and_case(): Promise<void> {
  const workspace = await fixtureWorkspace();
  try {
    await bindCaseToSyntheticSource(workspace);
    const imported = importOutput(workspace);
    assert.equal(imported.status, 0, imported.stderr);

    const artifactPath = "commands/projects/current-json.json";
    const source = await jsonFile<{ readonly command_outputs: readonly string[] }>(join(workspace.sourceDirectory, "source.json"));
    const caseSource = await jsonFile<{ readonly oracle_output: string }>(join(workspace.caseDirectory, "source.json"));
    const artifact = await jsonFile<{
      readonly source_id: string;
      readonly case: string;
      readonly evidence_kind: string;
      readonly projection: unknown;
      readonly replay_entrypoint: string;
      readonly replay_harness_sha256: string;
      readonly replay_session_sha256: string;
      readonly stdout_sha256: string;
    }>(join(workspace.sourceDirectory, artifactPath));
    assert.deepEqual(source.command_outputs, [artifactPath]);
    assert.equal((await jsonFile<{ readonly id: string }>(join(workspace.caseDirectory, "source.json"))).id, "oracle-test");
    assert.equal(caseSource.oracle_output, artifactPath);
    assert.equal(artifact.source_id, "oracle-test");
    assert.equal(artifact.case, "projects/current-json");
    assert.equal(artifact.evidence_kind, "reproducible_fixture_replay");
    assert.equal(artifact.replay_entrypoint, "ontrack_cli.cli");
    assert.match(artifact.replay_harness_sha256, /^[0-9a-f]{64}$/u);
    assert.match(artifact.replay_session_sha256, /^[0-9a-f]{64}$/u);
    assert.deepEqual(artifact.projection, []);
    assert.equal(artifact.stdout_sha256, createHash("sha256").update("[]\n").digest("hex"));
    assert.equal(await readFile(join(workspace.caseDirectory, "stdout.json"), "utf8"), "[]\n");
    assert.equal(verify(workspace).status, 0);
  } finally {
    await rm(workspace.directory, { recursive: true, force: true });
  }
}

export async function test_command_output_import_ignores_environment_key_order(): Promise<void> {
  const workspace = await fixtureWorkspace("[]\n", "[]\n", "projects/current-json", ["projects", "--json"], {
    ONTRACK_NOW: "2026-07-26T12:00:00+08:00",
    COLUMNS: "120",
    NO_COLOR: "1",
  });
  try {
    const imported = importOutput(workspace);
    assert.equal(imported.status, 0, imported.stderr);
    const verified = verify(workspace);
    assert.equal(verified.status, 0, verified.stderr);
  } finally {
    await rm(workspace.directory, { recursive: true, force: true });
  }
}

export async function test_command_output_import_rejects_unsanitized_identity(): Promise<void> {
  const workspace = await fixtureWorkspace(`${JSON.stringify({ username: "real-student" }, null, 2)}\n`);
  try {
    const result = importOutput(workspace);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /not sanitized|forbidden identity/u);
  } finally {
    await rm(workspace.directory, { recursive: true, force: true });
  }
}

export async function test_command_output_import_rejects_a_raw_numeric_id(): Promise<void> {
  const workspace = await fixtureWorkspace(`${JSON.stringify([{ id: 9182 }], null, 2)}\n`, "[]\n");
  try {
    const result = importOutput(workspace);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /(?:non-sanitized|invalid pseudonym) identifier|parity projection does not match/u);
  } finally {
    await rm(workspace.directory, { recursive: true, force: true });
  }
}

export async function test_command_output_import_accepts_distinct_stable_id_pseudonyms(): Promise<void> {
  const output = `${JSON.stringify([{ id: 1, unit: { id: 2, code: "UNIT", name: "Unit" } }], null, 2)}\n`;
  const workspace = await fixtureWorkspace(output);
  try {
    const result = importOutput(workspace);
    assert.equal(result.status, 0, result.stderr);
  } finally {
    await rm(workspace.directory, { recursive: true, force: true });
  }
}

export async function test_command_output_import_rejects_raw_unit_name_and_code(): Promise<void> {
  const workspace = await fixtureWorkspace(`${JSON.stringify([{
    unit: { id: 1, code: "FIT9999", name: "Private Unit" },
  }], null, 2)}\n`, "[]\n");
  try {
    const result = importOutput(workspace);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /forbidden identity|parity projection does not match/u);
  } finally {
    await rm(workspace.directory, { recursive: true, force: true });
  }
}

export async function test_command_output_import_rejects_identity_text_disguised_as_status_labels(): Promise<void> {
  const output = `${JSON.stringify([{ id: 1, status: "john_doe", status_label: "John Doe" }], null, 2)}\n`;
  const workspace = await fixtureWorkspace(output, output, "tasks/all-json", ["tasks", "1", "--json"]);
  try {
    const result = importOutput(workspace);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /invalid status (?:key|label)/u);
  } finally {
    await rm(workspace.directory, { recursive: true, force: true });
  }
}

export async function test_command_output_import_rejects_identity_text_disguised_as_unknown_status(): Promise<void> {
  const output = `${JSON.stringify([{ id: 1, status: "john_doe", status_label: "john_doe" }], null, 2)}\n`;
  const workspace = await fixtureWorkspace(output, output, "tasks/all-json", ["tasks", "1", "--json"]);
  try {
    const result = importOutput(workspace);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /invalid status key/u);
  } finally {
    await rm(workspace.directory, { recursive: true, force: true });
  }
}

export async function test_command_output_import_rejects_identity_text_in_a_status_label_without_a_status(): Promise<void> {
  const output = `${JSON.stringify([{ id: 1, status_label: "John Doe" }], null, 2)}\n`;
  const workspace = await fixtureWorkspace(output, output, "tasks/all-json", ["tasks", "1", "--json"]);
  try {
    const result = importOutput(workspace);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /status label requires a status key/u);
  } finally {
    await rm(workspace.directory, { recursive: true, force: true });
  }
}

export async function test_command_output_import_rejects_identity_text_disguised_as_a_role(): Promise<void> {
  const output = `${JSON.stringify([{ id: 1, role: "John Doe" }], null, 2)}\n`;
  const workspace = await fixtureWorkspace(output, output, "roles/all-json", ["roles", "--all", "--json"]);
  try {
    const result = importOutput(workspace);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /invalid enum text in role/u);
  } finally {
    await rm(workspace.directory, { recursive: true, force: true });
  }
}

export async function test_task_projection_allows_exempt_schedule_and_label_differences(): Promise<void> {
  const preserved = {
    id: 1,
    task_definition_id: 1,
    abbreviation: "TASK",
    name: "Unit",
    status: "rediscuss",
    target_grade: 1,
    extensions: 1,
    grade: null,
    quality_pts: 4,
    include_in_portfolio: true,
  };
  const python = [{
    ...preserved,
    status_label: "rediscuss",
    target_grade_label: "C (Credit)",
    start_date: "2000-01-01",
    target_date: "2026-07-28",
    due_date: "2000-01-01",
    deadline: "2000-01-01",
    submission_date: "2026-07-29",
    completion_date: null,
    grade_label: "-",
    is_overdue: true,
  }];
  const typescript = [{
    ...preserved,
    status_label: "Rediscuss",
    target_grade_label: "M (Mastery)",
    start_date: "2026-07-20",
    target_date: "2026-07-28",
    target_start_date: "2026-07-20",
    target_due_date: "2026-07-30",
    due_date: "2026-07-30",
    deadline: "2026-08-01",
    submission_date: "2026-07-29",
    completion_date: null,
    moved_to_discuss_at: "2026-07-25T01:00:00.000Z",
    discuss_timeout_expiry_at: "2026-07-26T01:00:00.000Z",
    grade_label: "-",
    is_overdue: false,
    is_discuss_overdue: true,
  }];
  const workspace = await fixtureWorkspace(
    `${JSON.stringify(python, null, 2)}\n`,
    `${JSON.stringify(typescript, null, 2)}\n`,
    "tasks/all-json",
    ["tasks", "1", "--json"],
  );
  try {
    const result = importOutput(workspace);
    assert.equal(result.status, 0, result.stderr);
    const artifact = await jsonFile<Record<string, unknown>>(join(workspace.sourceDirectory, "commands", "tasks", "all-json.json"));
    assert.equal(artifact.stdout, `${JSON.stringify(python, null, 2)}\n`);
    assert.equal(JSON.stringify(artifact.projection).includes("rediscuss"), true);
    assert.equal(verify(workspace).status, 0);
  } finally {
    await rm(workspace.directory, { recursive: true, force: true });
  }
}

export async function test_task_projection_rejects_preserved_id_or_name_differences(): Promise<void> {
  const typescript = [{ id: 1, task_definition_id: 1, abbreviation: "TASK", name: "Unit", status: "not_started" }];
  for (const python of [
    [{ ...typescript[0], id: 9182 }],
    [{ ...typescript[0], name: "Private Unit" }],
  ]) {
    const workspace = await fixtureWorkspace(
      `${JSON.stringify(python, null, 2)}\n`,
      `${JSON.stringify(typescript, null, 2)}\n`,
      "tasks/all-json",
      ["tasks", "1", "--json"],
    );
    try {
      const result = importOutput(workspace);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /forbidden identity|(?:non-sanitized|invalid pseudonym) identifier|parity projection does not match/u);
    } finally {
      await rm(workspace.directory, { recursive: true, force: true });
    }
  }
}

export async function test_task_projection_rejects_preserved_date_differences(): Promise<void> {
  const preserved = { id: 1, task_definition_id: 1, abbreviation: "TASK", name: "Unit", status: "not_started" };
  for (const field of ["submission_date", "target_date"] as const) {
    const workspace = await fixtureWorkspace(
      `${JSON.stringify([{ ...preserved, [field]: "2000-01-01" }], null, 2)}\n`,
      `${JSON.stringify([{ ...preserved, [field]: "2026-07-29" }], null, 2)}\n`,
      "tasks/all-json",
      ["tasks", "1", "--json"],
    );
    try {
      const result = importOutput(workspace);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /parity projection does not match/u);
    } finally {
      await rm(workspace.directory, { recursive: true, force: true });
    }
  }
}

export async function test_project_projection_rejects_preserved_task_definition_due_date(): Promise<void> {
  const project = { id: 1, tasks: [] };
  const definition = { id: 1, abbreviation: "TASK", name: "Unit", due_date: "2000-01-01" };
  const python = { project, unit: { summary: { id: 1 }, description: null, task_definitions: [definition] }, tasks: [] };
  const typescript = {
    project,
    unit: {
      summary: { id: 1 },
      description: null,
      grade_definitions: [],
      task_definitions: [{ ...definition, due_date: "2026-08-01", grade_due_dates: [] }],
    },
    tasks: [],
  };
  const workspace = await fixtureWorkspace(
    `${JSON.stringify(python, null, 2)}\n`,
    `${JSON.stringify(typescript, null, 2)}\n`,
    "project/maximal-json",
    ["project", "1", "--json"],
  );
  try {
    const result = importOutput(workspace);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /parity projection does not match/u);
  } finally {
    await rm(workspace.directory, { recursive: true, force: true });
  }
}

export async function test_project_projection_preserves_grade_catalog_and_schedule_structure(): Promise<void> {
  const definition = { id: 1, abbreviation: "TASK", name: "Unit", due_date: "2026-08-01" };
  const grade = { id: "mastery", value: 1, label: "Mastery", abbreviation: "M" };
  const base = {
    project: { id: 1, tasks: [] },
    unit: { summary: { id: 1 }, description: null, grade_definitions: [grade], task_definitions: [definition] },
    tasks: [],
  };
  const variants = [
    { ...base, unit: { ...base.unit, grade_definitions: [] } },
    {
      ...base,
      unit: {
        ...base.unit,
        task_definitions: [{ ...definition, grade_due_dates: [{ target_grade: 1, target_due_date: "2026-08-01" }] }],
      },
    },
  ];
  for (const python of variants) {
    const workspace = await fixtureWorkspace(
      `${JSON.stringify(python, null, 2)}\n`,
      `${JSON.stringify(base, null, 2)}\n`,
      "project/maximal-json",
      ["project", "1", "--json"],
    );
    try {
      const result = importOutput(workspace);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /(?:non-sanitized|invalid pseudonym) identifier|parity projection does not match/u);
    } finally {
      await rm(workspace.directory, { recursive: true, force: true });
    }
  }
}

export async function test_task_projection_preserves_surviving_key_order(): Promise<void> {
  const python = [{ name: "Unit", id: 1, task_definition_id: 1, abbreviation: "TASK", status: "not_started" }];
  const typescript = [{ id: 1, task_definition_id: 1, abbreviation: "TASK", name: "Unit", status: "not_started" }];
  const workspace = await fixtureWorkspace(
    `${JSON.stringify(python, null, 2)}\n`,
    `${JSON.stringify(typescript, null, 2)}\n`,
    "tasks/all-json",
    ["tasks", "1", "--json"],
  );
  try {
    const result = importOutput(workspace);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /parity projection does not match/u);
  } finally {
    await rm(workspace.directory, { recursive: true, force: true });
  }
}

export async function test_task_projection_rejects_missing_or_reordered_corrected_keys(): Promise<void> {
  const python = [{
    id: 1,
    status: "rediscuss",
    status_label: "rediscuss",
    due_date: "2000-01-01",
    deadline: "2000-01-01",
    is_overdue: true,
  }];
  const variants = [
    [{ id: 1, status: "rediscuss", status_label: "rediscuss", deadline: "2026-08-01", is_overdue: false }],
    [{ id: 1, status: "rediscuss", due_date: "2026-07-30", status_label: "rediscuss", deadline: "2026-08-01", is_overdue: false }],
  ];
  for (const typescript of variants) {
    const workspace = await fixtureWorkspace(
      `${JSON.stringify(python, null, 2)}\n`,
      `${JSON.stringify(typescript, null, 2)}\n`,
      "tasks/all-json",
      ["tasks", "1", "--json"],
    );
    try {
      const result = importOutput(workspace);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /parity projection does not match/u);
    } finally {
      await rm(workspace.directory, { recursive: true, force: true });
    }
  }
}

export async function test_command_output_import_rejects_noncanonical_python_json_whitespace(): Promise<void> {
  const workspace = await fixtureWorkspace("[ ]\n", "[]\n");
  try {
    const result = importOutput(workspace);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /standard JSON formatting/u);
  } finally {
    await rm(workspace.directory, { recursive: true, force: true });
  }
}

export async function test_command_output_import_rejects_unbound_replay_provenance(): Promise<void> {
  const workspace = await fixtureWorkspace();
  try {
    const provenance = await jsonFile<Record<string, unknown>>(workspace.replayProvenance);
    await writeFile(workspace.replayProvenance, `${JSON.stringify({
      ...provenance,
      python_commit: "0000000000000000000000000000000000000000",
    }, null, 2)}\n`, "utf8");
    const result = importOutput(workspace);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /replay provenance.*Python oracle commit/u);
  } finally {
    await rm(workspace.directory, { recursive: true, force: true });
  }
}

export async function test_project_projection_preserves_raw_array_order(): Promise<void> {
  const taskOne = { id: 1, task_definition_id: 1, status: "not_started" };
  const taskTwo = { id: 2, task_definition_id: 2, status: "not_started" };
  const definitionOne = { id: 1, abbreviation: "TASK", name: "Unit" };
  const definitionTwo = { id: 2, abbreviation: "TASK", name: "Unit" };
  const base = { project: { id: 1, tasks: [taskOne, taskTwo] }, unit: { task_definitions: [definitionOne, definitionTwo] }, tasks: [] };
  const variants = [
    { ...base, project: { ...base.project, tasks: [taskTwo, taskOne] } },
    { ...base, unit: { ...base.unit, task_definitions: [definitionTwo, definitionOne] } },
  ];
  for (const python of variants) {
    const workspace = await fixtureWorkspace(
      `${JSON.stringify(python, null, 2)}\n`,
      `${JSON.stringify(base, null, 2)}\n`,
      "project/maximal-json",
      ["project", "1", "--json"],
    );
    try {
      const result = importOutput(workspace);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /(?:non-sanitized|invalid pseudonym) identifier|parity projection does not match/u);
    } finally {
      await rm(workspace.directory, { recursive: true, force: true });
    }
  }
}

export async function test_oracle_verifier_rejects_a_source_without_command_output(): Promise<void> {
  const workspace = await fixtureWorkspace();
  try {
    const result = verify(workspace);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /orphan python_oracle source/u);
  } finally {
    await rm(workspace.directory, { recursive: true, force: true });
  }
}

export async function test_oracle_verifier_rejects_output_not_referenced_by_its_case(): Promise<void> {
  const workspace = await fixtureWorkspace();
  try {
    assert.equal(importOutput(workspace).status, 0);
    await writeFile(join(workspace.caseDirectory, "source.json"), "{\"id\":\"oracle-test\"}\n", "utf8");
    const result = verify(workspace);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /does not reference its Python command output/u);
  } finally {
    await rm(workspace.directory, { recursive: true, force: true });
  }
}

export async function test_oracle_verifier_rejects_a_relabelled_non_live_source(): Promise<void> {
  const workspace = await fixtureWorkspace();
  try {
    assert.equal(importOutput(workspace).status, 0);
    const sourcePath = join(workspace.sourceDirectory, "source.json");
    const source = await jsonFile<Record<string, unknown>>(sourcePath);
    await writeFile(sourcePath, `${JSON.stringify({ ...source, live_recorded: false }, null, 2)}\n`, "utf8");
    const result = verify(workspace);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Python-oracle source metadata is invalid/u);
  } finally {
    await rm(workspace.directory, { recursive: true, force: true });
  }
}

export async function test_oracle_verifier_rejects_golden_bytes_that_differ_from_python(): Promise<void> {
  const workspace = await fixtureWorkspace();
  try {
    assert.equal(importOutput(workspace).status, 0);
    await writeFile(join(workspace.caseDirectory, "stdout.json"), `${JSON.stringify([1], null, 2)}\n`, "utf8");
    const result = verify(workspace);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /parity projection does not match Python evidence/u);
  } finally {
    await rm(workspace.directory, { recursive: true, force: true });
  }
}

export async function test_oracle_verifier_leaves_nonrepresentative_cases_synthetic(): Promise<void> {
  const workspace = await fixtureWorkspace();
  try {
    assert.equal(importOutput(workspace).status, 0);
    const secondCase = join(workspace.directory, "tests", "golden", "projects", "second-json");
    await mkdir(secondCase, { recursive: true });
    await Promise.all([
      writeFile(join(secondCase, "argv"), "[\"projects\",\"--json\"]\n", "utf8"),
      writeFile(join(secondCase, "env"), "{}\n", "utf8"),
      writeFile(join(secondCase, "exit"), "0\n", "utf8"),
      writeFile(join(secondCase, "source.json"), "{\"id\":\"oracle-test\"}\n", "utf8"),
      writeFile(join(secondCase, "stderr.txt"), "", "utf8"),
      writeFile(join(secondCase, "stdout.json"), "[]\n", "utf8"),
    ]);
    const result = verify(workspace);
    assert.equal(result.status, 0, result.stderr);
  } finally {
    await rm(workspace.directory, { recursive: true, force: true });
  }
}

export async function test_oracle_verifier_requires_the_explicit_representative_case_set(): Promise<void> {
  const manifest = await jsonFile<Record<string, readonly string[]>>(join(process.cwd(), "tests", "golden", "oracle-required-cases.json"));
  assert.deepEqual(Object.keys(manifest), [
    "auth-check/maximal-json",
    "project/maximal-json",
    "projects/current-json",
    "projects/include-inactive-json",
    "roles/active-json",
    "roles/all-json",
    "tasks/all-json",
    "tasks/filter-rediscuss-json",
    "user/maximal-json",
  ]);
}

export async function test_oracle_verifier_rejects_missing_or_malformed_required_cases(): Promise<void> {
  const missing = await fixtureWorkspace();
  try {
    await writeFile(
      join(missing.directory, "tests", "golden", "oracle-required-cases.json"),
      "{\"projects/missing-json\":[\"projects\",\"--json\"]}\n",
      "utf8",
    );
    const result = verify(missing);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /projects\/missing-json: required oracle case is missing/u);
  } finally {
    await rm(missing.directory, { recursive: true, force: true });
  }

  const malformed = await fixtureWorkspace();
  try {
    await writeFile(join(malformed.caseDirectory, "argv"), "[\"projects\"]\n", "utf8");
    const result = verify(malformed);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /projects\/current-json: required oracle case is not a successful JSON command/u);
  } finally {
    await rm(malformed.directory, { recursive: true, force: true });
  }
}
