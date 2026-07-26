import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = process.cwd();
const runner = join(root, "scripts", "golden-replay-python.mjs");
const harness = join(root, "scripts", "python-replay-sitecustomize.py");
const fixture = join(root, "tests", "golden", "sources", "synthetic-minimal", "http.json");
const session = join(root, "tests", "golden", "sources", "synthetic-minimal", "session.json");
const pythonLookup = process.platform === "win32"
  ? spawnSync("where", ["python"], { encoding: "utf8" })
  : spawnSync("which", ["python3"], { encoding: "utf8" });
const python = pythonLookup.status === 0 ? pythonLookup.stdout?.split(/\r?\n/u)[0]?.trim() ?? "" : "";

const appSource = String.raw`
import json
import sys

import requests

BASE_URL = "https://school.example.invalid"


def fetch(path, params=None):
    response = requests.Session().request("GET", BASE_URL + path, params=params)
    assert response.status_code == 200
    assert isinstance(response.content, bytes)
    assert isinstance(response.text, str)
    assert response.json() == json.loads(response.text)
    return response.json()


def main():
    command = sys.argv[1]
    if command in {"user", "auth-check"}:
        result = {
            "method": fetch("/api/auth/method"),
            "projects": fetch("/api/projects", {"include_inactive": True}),
            "roles": fetch("/api/unit_roles", {"active_only": False}),
        }
    elif command == "projects":
        result = fetch("/api/projects", {"include_inactive": False})
    elif command in {"project", "tasks"}:
        project = fetch("/api/projects/1")
        unit = fetch(f"/api/units/{project['unit']['id']}")
        definitions = {item["id"]: item for item in unit["task_definitions"]}
        rows = [
            {
                "task_id": task["id"],
                "task_definition_id": definitions[task["task_definition_id"]]["id"],
            }
            for task in project["tasks"]
        ]
        result = {"project": project, "unit": unit, "rows": rows} if command == "project" else rows
    elif command == "roles":
        result = fetch("/api/unit_roles", {"active_only": True})
    elif command == "crlf":
        result = {"line_endings": "portable"}
    elif command == "unknown":
        result = fetch("/api/private")
    elif command == "wrong-params":
        result = fetch("/api/projects", {"include_inactive": "false"})
    elif command == "post":
        result = requests.Session().request("POST", BASE_URL + "/api/projects")
    elif command == "live-host":
        result = requests.Session().request("GET", "https://ontrack.infotech.monash.edu/api/projects", params={"include_inactive": False})
    else:
        raise AssertionError("unknown test command")
    output = json.dumps(result, indent=2)
    if command == "crlf":
        sys.stdout.buffer.write((output + "\r\n").encode("utf-8"))
    else:
        print(output)


main()
`;

const requestsSource = String.raw`
from pathlib import Path


def _network():
    Path(__file__).resolve().parent.parent.joinpath("network-used").write_text("network used", encoding="utf-8")
    raise AssertionError("the original requests transport was reached")


class Session:
    def request(self, method, url, **kwargs):
        return _network()


def request(method, url, **kwargs):
    return _network()


def get(url, **kwargs):
    return _network()


def post(url, **kwargs):
    return _network()
`;

interface ReplayWorkspace {
  readonly directory: string;
  readonly checkout: string;
  readonly commit: string;
  readonly env: string;
}

interface ReplayResult {
  readonly process: SpawnSyncReturns<string>;
  readonly stdout: string;
  readonly stderr: string;
  readonly exit: string;
  readonly provenance: Record<string, unknown>;
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function git(cwd: string, args: readonly string[]): SpawnSyncReturns<string> {
  return spawnSync("git", args, { cwd, encoding: "utf8" });
}

async function createWorkspace(): Promise<ReplayWorkspace> {
  assert.ok(python, "python3 must be available for replay tests");
  const directory = await mkdtemp(join(tmpdir(), "ontrack-python-replay-"));
  const checkout = join(directory, "python-release");
  await mkdir(join(checkout, "requests"), { recursive: true });
  await mkdir(join(checkout, "scripts"), { recursive: true });
  await Promise.all([
    writeFile(join(checkout, "fixture_cli.py"), appSource, "utf8"),
    writeFile(join(checkout, "requests", "__init__.py"), requestsSource, "utf8"),
    writeFile(join(checkout, "scripts", "python-replay-sitecustomize.py"), await readFile(harness), "utf8"),
  ]);
  assert.equal(git(checkout, ["init", "--quiet"]).status, 0);
  assert.equal(git(checkout, ["add", "."]).status, 0);
  const commitResult = git(checkout, [
    "-c", "user.name=Replay Test",
    "-c", "user.email=replay@example.invalid",
    "-c", "commit.gpgsign=false",
    "commit", "--quiet", "-m", "test fixture app",
  ]);
  assert.equal(commitResult.status, 0, commitResult.stderr);
  const commit = git(checkout, ["rev-parse", "HEAD"]).stdout.trim();
  const env = join(directory, "env.json");
  await writeFile(env, `${JSON.stringify({ COLUMNS: "120", NO_COLOR: "1" })}\n`, "utf8");
  return { directory, checkout, commit, env };
}

async function runReplay(
  workspace: ReplayWorkspace,
  argv: readonly string[],
  fixturePath = fixture,
  sessionPath = session,
): Promise<ReplayResult> {
  const caseDirectory = join(workspace.directory, `case-${argv[0]}-${Math.random().toString(16).slice(2)}`);
  await mkdir(caseDirectory);
  const stdoutPath = join(caseDirectory, "stdout.json");
  const stderrPath = join(caseDirectory, "stderr.txt");
  const exitPath = join(caseDirectory, "exit");
  const provenancePath = join(caseDirectory, "provenance.json");
  const result = spawnSync(process.execPath, [
    runner,
    "--python", python,
    "--python-checkout", workspace.checkout,
    "--tool-checkout", workspace.checkout,
    "--entrypoint", "fixture_cli",
    "--fixture", fixturePath,
    "--session", sessionPath,
    "--env", workspace.env,
    "--stdout", stdoutPath,
    "--stderr", stderrPath,
    "--exit", exitPath,
    "--provenance", provenancePath,
    "--",
    ...argv,
  ], { encoding: "utf8" });

  const optionalRead = async (path: string): Promise<string> => {
    try {
      return await readFile(path, "utf8");
    } catch {
      return "";
    }
  };
  const provenanceText = await optionalRead(provenancePath);
  return {
    process: result,
    stdout: await optionalRead(stdoutPath),
    stderr: await optionalRead(stderrPath),
    exit: await optionalRead(exitPath),
    provenance: provenanceText ? JSON.parse(provenanceText) as Record<string, unknown> : {},
  };
}

async function assertNoNetwork(checkout: string): Promise<void> {
  await assert.rejects(access(join(checkout, "network-used")));
}

export async function test_python_replay_runs_the_six_command_request_paths_and_records_provenance(): Promise<void> {
  const workspace = await createWorkspace();
  try {
    for (const command of ["user", "auth-check", "projects", "project", "tasks", "roles"]) {
      const result = await runReplay(workspace, [command]);
      assert.equal(result.process.stdout, "");
      assert.equal(result.process.status, 0, result.process.stderr || result.stderr);
      assert.equal(result.exit, "0\n");
      assert.equal(result.stdout, `${JSON.stringify(JSON.parse(result.stdout), null, 2)}\n`);
      assert.doesNotThrow(() => JSON.parse(result.stdout));
      assert.equal(result.provenance.schema, 1);
      assert.equal(result.provenance.kind, "python_fixture_replay");
      assert.equal(result.provenance.python_commit, workspace.commit);
      assert.equal(result.provenance.replay_tool_commit, workspace.commit);
      assert.deepEqual(result.provenance.argv, [command]);
      assert.deepEqual(result.provenance.env_allowlist, ["COLUMNS", "NO_COLOR"]);
      assert.deepEqual(result.provenance.env, { COLUMNS: "120", NO_COLOR: "1" });
      assert.equal(result.provenance.fixture_sha256, sha256(await readFile(fixture)));
      assert.equal(result.provenance.session_sha256, sha256(await readFile(session)));
      assert.equal(result.provenance.replay_harness_sha256, sha256(await readFile(harness)));
      assert.equal(result.provenance.entrypoint, "fixture_cli");
      assert.equal(result.provenance.stdout_sha256, sha256(result.stdout));
      assert.equal(result.provenance.stderr_sha256, sha256(result.stderr));
      assert.equal(JSON.stringify(result.provenance).includes(result.stdout.trim()), false);
    }
    await assertNoNetwork(workspace.checkout);
  } finally {
    await rm(workspace.directory, { recursive: true, force: true });
  }
}

export async function test_python_replay_requires_a_clean_python_checkout(): Promise<void> {
  const workspace = await createWorkspace();
  try {
    await writeFile(join(workspace.checkout, "dirty.txt"), "dirty\n", "utf8");
    const result = await runReplay(workspace, ["projects"]);
    assert.notEqual(result.process.status, 0);
    assert.match(result.process.stderr, /clean Git checkout/u);
    await assertNoNetwork(workspace.checkout);
  } finally {
    await rm(workspace.directory, { recursive: true, force: true });
  }
}

export async function test_python_replay_normalizes_stdout_line_endings(): Promise<void> {
  const workspace = await createWorkspace();
  try {
    const result = await runReplay(workspace, ["crlf"]);
    assert.equal(result.process.status, 0, result.process.stderr || result.stderr);
    assert.equal(result.stdout, "{\n  \"line_endings\": \"portable\"\n}\n");
    assert.equal(result.provenance.stdout_sha256, sha256(result.stdout));
  } finally {
    await rm(workspace.directory, { recursive: true, force: true });
  }
}

export async function test_python_replay_rejects_unknown_requests_without_reaching_the_transport(): Promise<void> {
  const workspace = await createWorkspace();
  try {
    const result = await runReplay(workspace, ["unknown"]);
    assert.notEqual(result.process.status, 0);
    assert.match(result.stderr, /no replay fixture for GET \/api\/private/u);
    assert.notEqual(result.exit, "0\n");
    await assertNoNetwork(workspace.checkout);
  } finally {
    await rm(workspace.directory, { recursive: true, force: true });
  }
}

export async function test_python_replay_rejects_wrong_params_non_get_and_live_hosts_without_network(): Promise<void> {
  const workspace = await createWorkspace();
  try {
    for (const [command, message] of [
      ["wrong-params", /no replay fixture for GET \/api\/projects/u],
      ["post", /only GET requests are allowed/u],
      ["live-host", /live or non-sanitized hostname/u],
    ] as const) {
      const result = await runReplay(workspace, [command]);
      assert.notEqual(result.process.status, 0);
      assert.match(result.stderr, message);
    }
    await assertNoNetwork(workspace.checkout);
  } finally {
    await rm(workspace.directory, { recursive: true, force: true });
  }
}

export async function test_python_replay_rejects_duplicate_fixture_keys_and_credential_shaped_values(): Promise<void> {
  const workspace = await createWorkspace();
  try {
    const baseFixture = JSON.parse(await readFile(fixture, "utf8")) as unknown[];
    const duplicateFixture = join(workspace.directory, "duplicate.json");
    await writeFile(duplicateFixture, `${JSON.stringify([...baseFixture, baseFixture[0]])}\n`, "utf8");
    const duplicate = await runReplay(workspace, ["projects"], duplicateFixture);
    assert.notEqual(duplicate.process.status, 0);
    assert.match(duplicate.stderr || duplicate.process.stderr, /duplicate replay fixture key/u);

    const unsafeFixture = join(workspace.directory, "unsafe.json");
    const unsafeRecords = structuredClone(baseFixture) as Array<Record<string, unknown>>;
    const response = unsafeRecords[0]?.response as Record<string, unknown>;
    response.json = { method: "saml", leaked: "Bearer abcdefghijklmnopqrstuvwxyz123456" };
    await writeFile(unsafeFixture, `${JSON.stringify(unsafeRecords)}\n`, "utf8");
    const unsafe = await runReplay(workspace, ["user"], unsafeFixture);
    assert.notEqual(unsafe.process.status, 0);
    assert.match(unsafe.stderr || unsafe.process.stderr, /credential-shaped value/u);
    await assertNoNetwork(workspace.checkout);
  } finally {
    await rm(workspace.directory, { recursive: true, force: true });
  }
}

export async function test_python_replay_preserves_multiple_task_definition_relationships(): Promise<void> {
  const workspace = await createWorkspace();
  try {
    const stableFixture = join(workspace.directory, "stable-ids.json");
    await writeFile(stableFixture, `${JSON.stringify([
      {
        request: { method: "GET", path: "/api/projects/1", params: {} },
        response: {
          status_code: 200,
          json: {
            id: 1,
            unit: { id: 6 },
            tasks: [
              { id: 2, task_definition_id: 3, status: "not_started" },
              { id: 4, task_definition_id: 5, status: "complete" },
            ],
          },
        },
      },
      {
        request: { method: "GET", path: "/api/units/6", params: {} },
        response: {
          status_code: 200,
          json: {
            id: 6,
            task_definitions: [
              { id: 3, abbreviation: "TASK", name: "Unit" },
              { id: 5, abbreviation: "TASK", name: "Unit" },
            ],
          },
        },
      },
    ], null, 2)}\n`, "utf8");

    const result = await runReplay(workspace, ["tasks"], stableFixture);
    assert.equal(result.process.status, 0, result.process.stderr || result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), [
      { task_id: 2, task_definition_id: 3 },
      { task_id: 4, task_definition_id: 5 },
    ]);
    await assertNoNetwork(workspace.checkout);
  } finally {
    await rm(workspace.directory, { recursive: true, force: true });
  }
}
