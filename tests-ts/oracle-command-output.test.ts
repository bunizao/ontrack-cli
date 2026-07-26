import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";

const importer = join(process.cwd(), "scripts", "golden-import-command-output.mjs");
const verifier = join(process.cwd(), "scripts", "golden-verify-oracle.mjs");
const oracleCommit = (JSON.parse(await readFile(join(process.cwd(), "tests", "golden", "oracle-provenance.json"), "utf8")) as { readonly python_release_commit: string }).python_release_commit;

interface FixtureWorkspace {
  readonly directory: string;
  readonly sourceDirectory: string;
  readonly caseDirectory: string;
  readonly stdoutCapture: string;
}

async function jsonFile<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

async function fixtureWorkspace(stdout = "[]\n", goldenStdout = stdout): Promise<FixtureWorkspace> {
  const directory = await mkdtemp(join(tmpdir(), "ontrack-command-oracle-"));
  const sourceDirectory = join(directory, "tests", "golden", "sources", "oracle-test");
  const caseDirectory = join(directory, "tests", "golden", "projects", "current-json");
  await Promise.all([
    mkdir(sourceDirectory, { recursive: true }),
    mkdir(caseDirectory, { recursive: true }),
  ]);
  const fixture = "[]\n";
  await Promise.all([
    writeFile(join(sourceDirectory, "http.json"), fixture, "utf8"),
    writeFile(join(sourceDirectory, "session.json"), "{}\n", "utf8"),
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
    writeFile(join(caseDirectory, "argv"), "[\"projects\",\"--json\"]\n", "utf8"),
    writeFile(join(caseDirectory, "env"), "{}\n", "utf8"),
    writeFile(join(caseDirectory, "exit"), "0\n", "utf8"),
    writeFile(join(caseDirectory, "source.json"), "{\"id\":\"oracle-test\"}\n", "utf8"),
    writeFile(join(caseDirectory, "stderr.txt"), "", "utf8"),
    writeFile(join(caseDirectory, "stdout.json"), goldenStdout, "utf8"),
  ]);
  const stdoutCapture = join(directory, "python-stdout.json");
  await writeFile(stdoutCapture, stdout, "utf8");
  for (const command of [
    ["init", "--quiet"],
    ["add", "tests"],
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
  return { directory, sourceDirectory, caseDirectory, stdoutCapture };
}

function importOutput(workspace: FixtureWorkspace): SpawnSyncReturns<string> {
  return spawnSync(process.execPath, [
    importer,
    workspace.stdoutCapture,
    "oracle-test",
    "projects/current-json",
    "2026-07-26T12:01:00Z",
    "--confirm-sanitized-python-output",
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
      readonly stdout: string;
      readonly stdout_sha256: string;
    }>(join(workspace.sourceDirectory, artifactPath));
    assert.deepEqual(source.command_outputs, [artifactPath]);
    assert.equal((await jsonFile<{ readonly id: string }>(join(workspace.caseDirectory, "source.json"))).id, "oracle-test");
    assert.equal(caseSource.oracle_output, artifactPath);
    assert.equal(artifact.source_id, "oracle-test");
    assert.equal(artifact.case, "projects/current-json");
    assert.equal(artifact.stdout, "[]\n");
    assert.equal(artifact.stdout_sha256, createHash("sha256").update("[]\n").digest("hex"));
    assert.equal(await readFile(join(workspace.caseDirectory, "stdout.json"), "utf8"), "[]\n");
    assert.equal(verify(workspace).status, 0);
  } finally {
    await rm(workspace.directory, { recursive: true, force: true });
  }
}

export async function test_command_output_import_rejects_unsanitized_identity(): Promise<void> {
  const workspace = await fixtureWorkspace("{\"username\":\"real-student\"}\n");
  try {
    const result = importOutput(workspace);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /not sanitized|forbidden identity/u);
  } finally {
    await rm(workspace.directory, { recursive: true, force: true });
  }
}

export async function test_command_output_import_rejects_a_raw_numeric_id(): Promise<void> {
  const workspace = await fixtureWorkspace("[{\"id\":9182}]\n", "[]\n");
  try {
    const result = importOutput(workspace);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /does not match the committed synthetic golden/u);
  } finally {
    await rm(workspace.directory, { recursive: true, force: true });
  }
}

export async function test_command_output_import_rejects_raw_unit_name_and_code(): Promise<void> {
  const workspace = await fixtureWorkspace("[{\"unit\":{\"id\":1,\"code\":\"FIT9999\",\"name\":\"Private Unit\"}}]\n", "[]\n");
  try {
    const result = importOutput(workspace);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /does not match the committed synthetic golden/u);
  } finally {
    await rm(workspace.directory, { recursive: true, force: true });
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

export async function test_oracle_verifier_rejects_golden_bytes_that_differ_from_python(): Promise<void> {
  const workspace = await fixtureWorkspace();
  try {
    assert.equal(importOutput(workspace).status, 0);
    await writeFile(join(workspace.caseDirectory, "stdout.json"), "[1]\n", "utf8");
    const result = verify(workspace);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /does not match Python stdout/u);
  } finally {
    await rm(workspace.directory, { recursive: true, force: true });
  }
}

export async function test_oracle_verifier_rejects_an_unproven_case_bound_to_the_source(): Promise<void> {
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
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /projects\/second-json.*has no Python command output/u);
  } finally {
    await rm(workspace.directory, { recursive: true, force: true });
  }
}
