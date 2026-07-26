import assert from "node:assert/strict";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

interface OracleHelpers {
  parityProjection(caseName: string, value: unknown): unknown;
  validateSanitizedJsonStdout(stdout: string): unknown;
}

interface OracleWorkspace {
  readonly directory: string;
  readonly sourceDirectory: string;
  readonly caseDirectory: string;
}

const root = process.cwd();
const verifierName = "golden-verify-oracle.mjs";
const helperName = "golden-command-oracle.mjs";
const harnessName = "python-replay-sitecustomize.py";
const helpers = await import(pathToFileURL(join(root, "scripts", helperName)).href) as OracleHelpers;
const oracleCommit = (JSON.parse(await readFile(join(root, "tests", "golden", "oracle-provenance.json"), "utf8")) as {
  readonly python_release_commit: string;
}).python_release_commit;

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function git(directory: string, args: readonly string[]): SpawnSyncReturns<string> {
  return spawnSync("git", args, { cwd: directory, encoding: "utf8" });
}

async function createOracleWorkspace(): Promise<OracleWorkspace> {
  const directory = await mkdtemp(join(tmpdir(), "ontrack-oracle-verifier-"));
  const scriptsDirectory = join(directory, "scripts");
  const goldenDirectory = join(directory, "tests", "golden");
  const sourceDirectory = join(goldenDirectory, "sources", "oracle-test");
  const commandsDirectory = join(sourceDirectory, "commands", "projects");
  const caseDirectory = join(goldenDirectory, "projects", "current-json");
  await Promise.all([
    mkdir(scriptsDirectory, { recursive: true }),
    mkdir(commandsDirectory, { recursive: true }),
    mkdir(caseDirectory, { recursive: true }),
  ]);
  await Promise.all([
    copyFile(join(root, "scripts", verifierName), join(scriptsDirectory, verifierName)),
    copyFile(join(root, "scripts", helperName), join(scriptsDirectory, helperName)),
    copyFile(join(root, "scripts", harnessName), join(scriptsDirectory, harnessName)),
  ]);

  assert.equal(git(directory, ["init", "--quiet"]).status, 0);
  assert.equal(git(directory, ["add", `scripts/${harnessName}`]).status, 0);
  const committed = git(directory, [
    "-c", "user.name=Oracle Test",
    "-c", "user.email=oracle@example.invalid",
    "-c", "commit.gpgsign=false",
    "commit", "--quiet", "-m", "test: seed replay harness",
  ]);
  assert.equal(committed.status, 0, committed.stderr);
  const replayToolCommit = git(directory, ["rev-parse", "HEAD"]).stdout.trim();

  const fixture = "[]\n";
  const session = `${JSON.stringify({
    base_url: "https://school.example.invalid",
    username: "recorded-user",
  }, null, 2)}\n`;
  const stdout = "[]\n";
  const harness = await readFile(join(scriptsDirectory, harnessName));
  const argv = ["projects", "--json"];
  const artifactPath = "commands/projects/current-json.json";
  const replayHarnessSha256 = sha256(harness);
  const replaySessionSha256 = sha256(session);
  const stdoutSha256 = sha256(stdout);

  await Promise.all([
    writeJson(join(goldenDirectory, "oracle-provenance.json"), {
      schema: 1,
      python_release_commit: oracleCommit,
    }),
    writeJson(join(goldenDirectory, "oracle-required-cases.json"), {
      "projects/current-json": argv,
    }),
    writeFile(join(sourceDirectory, "http.json"), fixture, "utf8"),
    writeFile(join(sourceDirectory, "session.json"), session, "utf8"),
    writeJson(join(sourceDirectory, "source.json"), {
      schema: 1,
      kind: "python_oracle",
      live_recorded: true,
      description: "Test oracle source",
      fixture: "http.json",
      session: "session.json",
      oracle_commit: oracleCommit,
      recorded_at: "2026-07-26T12:00:00.000Z",
      capture_sha256: sha256(fixture),
      command_outputs: [artifactPath],
    }),
    writeJson(join(commandsDirectory, "current-json.json"), {
      schema: 4,
      kind: "python_command_output",
      evidence_kind: "reproducible_fixture_replay",
      source_id: "oracle-test",
      case: "projects/current-json",
      oracle_commit: oracleCommit,
      recorded_at: "2026-07-26T12:01:00.000Z",
      source_capture_sha256: sha256(fixture),
      replay_entrypoint: "ontrack_cli.cli",
      replay_harness_sha256: replayHarnessSha256,
      replay_session_sha256: replaySessionSha256,
      argv,
      env: {},
      stdout,
      stdout_sha256: stdoutSha256,
      stderr: "",
      exit: 0,
      projection: [],
      projection_sha256: stdoutSha256,
      replay_provenance: {
        schema: 1,
        kind: "python_fixture_replay",
        python_commit: oracleCommit,
        entrypoint: "ontrack_cli.cli",
        fixture_sha256: sha256(fixture),
        session_sha256: replaySessionSha256,
        replay_harness_sha256: replayHarnessSha256,
        replay_tool_commit: replayToolCommit,
        argv,
        env_allowlist: [],
        env: {},
        stdout_sha256: stdoutSha256,
        stderr_sha256: sha256(""),
        exit: 0,
      },
    }),
    writeJson(join(caseDirectory, "argv"), argv),
    writeJson(join(caseDirectory, "env"), {}),
    writeFile(join(caseDirectory, "exit"), "0\n", "utf8"),
    writeJson(join(caseDirectory, "source.json"), {
      id: "oracle-test",
      oracle_output: artifactPath,
    }),
    writeFile(join(caseDirectory, "stderr.txt"), "", "utf8"),
    writeFile(join(caseDirectory, "stdout.json"), stdout, "utf8"),
  ]);

  return { directory, sourceDirectory, caseDirectory };
}

function verify(workspace: OracleWorkspace): SpawnSyncReturns<string> {
  return spawnSync(process.execPath, [join(workspace.directory, "scripts", verifierName)], {
    cwd: workspace.directory,
    encoding: "utf8",
  });
}

async function withWorkspace(run: (workspace: OracleWorkspace) => Promise<void>): Promise<void> {
  const workspace = await createOracleWorkspace();
  try {
    await run(workspace);
  } finally {
    await rm(workspace.directory, { recursive: true, force: true });
  }
}

export function test_oracle_helpers_accept_sanitized_output(): void {
  const output = `${JSON.stringify({
    id: 1,
    username: "recorded-user",
    email: "recorded-user@example.invalid",
  }, null, 2)}\n`;

  assert.deepEqual(helpers.validateSanitizedJsonStdout(output), {
    id: 1,
    username: "recorded-user",
    email: "recorded-user@example.invalid",
  });
}

export function test_oracle_helpers_reject_credentials_and_raw_identity(): void {
  assert.throws(
    () => helpers.validateSanitizedJsonStdout('{"access_token":"secret"}\n'),
    /forbidden credential/u,
  );
  assert.throws(
    () => helpers.validateSanitizedJsonStdout('{"email":"student@monash.edu"}\n'),
    /forbidden identity/u,
  );
}

export function test_oracle_projection_normalizes_only_expected_task_fields(): void {
  const projected = helpers.parityProjection("tasks/all-json", [{
    id: 1,
    name: "Task",
    due_date: "2026-07-27",
    target_due_date: "2026-07-28",
    status_label: "Complete",
  }]);

  assert.deepEqual(projected, [{
    due_date: null,
    id: 1,
    name: "Task",
    status_label: null,
  }]);
}

export async function test_oracle_verifier_accepts_a_valid_corpus(): Promise<void> {
  await withWorkspace(async (workspace) => {
    const result = verify(workspace);
    assert.equal(result.status, 0, result.stderr);
  });
}

export async function test_oracle_verifier_rejects_an_orphan_source(): Promise<void> {
  await withWorkspace(async (workspace) => {
    const sourcePath = join(workspace.sourceDirectory, "source.json");
    const source = JSON.parse(await readFile(sourcePath, "utf8")) as Record<string, unknown>;
    delete source.command_outputs;
    await writeJson(sourcePath, source);
    assert.match(verify(workspace).stderr, /orphan python_oracle source/u);
  });
}

export async function test_oracle_verifier_rejects_an_unbound_case(): Promise<void> {
  await withWorkspace(async (workspace) => {
    await writeJson(join(workspace.caseDirectory, "source.json"), { id: "oracle-test" });
    assert.match(verify(workspace).stderr, /does not reference its Python command output/u);
  });
}

export async function test_oracle_verifier_rejects_a_relabelled_source(): Promise<void> {
  await withWorkspace(async (workspace) => {
    const sourcePath = join(workspace.sourceDirectory, "source.json");
    const source = JSON.parse(await readFile(sourcePath, "utf8")) as Record<string, unknown>;
    await writeJson(sourcePath, { ...source, live_recorded: false });
    assert.match(verify(workspace).stderr, /Python-oracle source metadata is invalid/u);
  });
}

export async function test_oracle_verifier_rejects_golden_output_drift(): Promise<void> {
  await withWorkspace(async (workspace) => {
    await writeFile(join(workspace.caseDirectory, "stdout.json"), "[\n  1\n]\n", "utf8");
    assert.match(verify(workspace).stderr, /parity projection does not match Python evidence/u);
  });
}

export async function test_oracle_verifier_rejects_a_missing_required_case(): Promise<void> {
  await withWorkspace(async (workspace) => {
    await writeJson(join(workspace.directory, "tests", "golden", "oracle-required-cases.json"), {
      "projects/missing-json": ["projects", "--json"],
    });
    assert.match(verify(workspace).stderr, /required oracle case is missing/u);
  });
}

export async function test_oracle_verifier_requires_the_representative_case_set(): Promise<void> {
  const manifest = JSON.parse(await readFile(join(root, "tests", "golden", "oracle-required-cases.json"), "utf8")) as Record<string, readonly string[]>;

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
