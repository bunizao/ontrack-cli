import { execFileSync } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";

import {
  hasExactKeys,
  isSafeArtifactPath,
  isSafeRelativePath,
  oracleCommit,
  parityProjection,
  projectionJson,
  readJson,
  sha256,
  validateSanitizedJsonStdout,
} from "./golden-command-oracle.mjs";

const root = join(process.cwd(), "tests", "golden");
const sourcesRoot = join(root, "sources");
const requiredOracleCaseArgv = await readJson(join(root, "oracle-required-cases.json"));
if (requiredOracleCaseArgv === null || typeof requiredOracleCaseArgv !== "object" || Array.isArray(requiredOracleCaseArgv)
  || !Object.entries(requiredOracleCaseArgv).every(([caseName, argv]) => isSafeRelativePath(caseName)
    && Array.isArray(argv) && argv.length > 0 && argv.every((value) => typeof value === "string"))) {
  throw new Error("oracle-required-cases.json must map command/case paths to exact argv arrays");
}
const requiredOracleCases = Object.keys(requiredOracleCaseArgv);
const artifactKeys = [
  "argv", "case", "env", "evidence_kind", "exit", "kind", "oracle_commit", "projection", "projection_sha256",
  "recorded_at", "replay_entrypoint", "replay_harness_sha256", "replay_session_sha256", "schema",
  "source_capture_sha256", "source_id", "stderr", "stdout", "stdout_sha256", "replay_provenance",
];
let replayHarnessDigest;
try {
  replayHarnessDigest = sha256(execFileSync("git", ["show", "HEAD:scripts/python-replay-sitecustomize.py"], {
    cwd: process.cwd(),
    encoding: "buffer",
  }));
} catch {
  throw new Error("Cannot read the committed replay harness");
}
let failures = 0;
let oracleSources = 0;
const oracleById = new Map();

function fail(message) {
  failures += 1;
  process.stderr.write(`${message}\n`);
}

async function directories(path) {
  return (await readdir(path, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

async function artifactFiles(path, prefix = "") {
  const files = [];
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...await artifactFiles(join(path, entry.name), relative));
    else files.push(relative);
  }
  return files.sort();
}

for (const sourceId of await directories(sourcesRoot)) {
  const sourceDirectory = join(sourcesRoot, sourceId);
  const source = await readJson(join(sourceDirectory, "source.json"));
  if (source.kind !== "python_oracle") continue;
  oracleSources += 1;
  oracleById.set(sourceId, source);
  const sourceKeys = [
    "capture_sha256", "description", "fixture", "kind", "live_recorded", "oracle_commit", "recorded_at",
    "schema", "session",
  ];
  const hasValidSourceKeys = hasExactKeys(source, sourceKeys)
    || hasExactKeys(source, [...sourceKeys, "command_outputs"]);
  if (!hasValidSourceKeys || source.schema !== 1 || source.live_recorded !== true
    || source.fixture !== "http.json" || source.session !== "session.json"
    || Number.isNaN(new Date(source.recorded_at).valueOf())) {
    fail(`${sourceId}: Python-oracle source metadata is invalid`);
    continue;
  }
  const outputs = source.command_outputs;
  if (!Array.isArray(outputs) || outputs.length === 0) {
    fail(`${sourceId}: orphan python_oracle source has no Python command outputs`);
    continue;
  }
  if (new Set(outputs).size !== outputs.length || !outputs.every(isSafeArtifactPath)) {
    fail(`${sourceId}: command_outputs contains invalid or duplicate paths`);
    continue;
  }
  const fixture = await readFile(join(sourceDirectory, source.fixture));
  const session = await readFile(join(sourceDirectory, source.session));
  if (source.oracle_commit !== oracleCommit || sha256(fixture) !== source.capture_sha256) {
    fail(`${sourceId}: Python-oracle HTTP provenance is invalid`);
    continue;
  }
  const commandsDirectory = join(sourceDirectory, "commands");
  let actualArtifacts;
  try {
    actualArtifacts = (await artifactFiles(commandsDirectory)).map((path) => `commands/${path}`);
  } catch {
    fail(`${sourceId}: command_outputs metadata has no artifact directory`);
    continue;
  }
  if (JSON.stringify([...outputs].sort()) !== JSON.stringify(actualArtifacts)) {
    fail(`${sourceId}: command_outputs does not exactly match stored artifacts`);
    continue;
  }

  for (const artifactPath of outputs) {
    try {
      const artifact = await readJson(join(sourceDirectory, artifactPath));
      if (!hasExactKeys(artifact, artifactKeys)) throw new Error("has unexpected fields");
      if (artifact.schema !== 4 || artifact.kind !== "python_command_output") throw new Error("has an invalid schema");
      if (artifact.evidence_kind !== "reproducible_fixture_replay") throw new Error("has invalid evidence provenance");
      if (artifact.source_id !== sourceId || artifact.oracle_commit !== oracleCommit) throw new Error("has invalid oracle identity");
      if (artifact.source_capture_sha256 !== source.capture_sha256) throw new Error("is not bound to the HTTP capture");
      if (!isSafeRelativePath(artifact.case) || artifactPath !== `commands/${artifact.case}.json`) throw new Error("has an invalid case path");
      if (Number.isNaN(new Date(artifact.recorded_at).valueOf())) throw new Error("has an invalid recording time");
      if (artifact.exit !== 0 || artifact.stderr !== "") throw new Error("is not a successful JSON command capture");
      if (typeof artifact.stdout !== "string" || sha256(artifact.stdout) !== artifact.stdout_sha256) throw new Error("has an invalid stdout digest");
      if (artifact.replay_entrypoint !== "ontrack_cli.cli"
        || artifact.replay_harness_sha256 !== replayHarnessDigest
        || artifact.replay_session_sha256 !== sha256(session)) {
        throw new Error("has invalid replay execution provenance");
      }
      const projectedJson = projectionJson(artifact.projection);
      if (sha256(projectedJson) !== artifact.projection_sha256) throw new Error("has an invalid projection digest");
      const replayedValue = validateSanitizedJsonStdout(artifact.stdout);
      if (artifact.stdout !== projectionJson(replayedValue)
        || projectionJson(parityProjection(artifact.case, replayedValue)) !== projectedJson) {
        throw new Error("stored replay stdout does not match its parity projection");
      }
      const replay = artifact.replay_provenance;
      const replayKeys = [
        "argv", "entrypoint", "env", "env_allowlist", "exit", "fixture_sha256", "kind", "python_commit",
        "replay_harness_sha256", "replay_tool_commit", "schema", "session_sha256", "stderr_sha256", "stdout_sha256",
      ];
      if (!hasExactKeys(replay, replayKeys) || replay.schema !== 1 || replay.kind !== "python_fixture_replay") {
        throw new Error("stored replay provenance has an invalid schema");
      }
      let replayCommitHarness;
      try {
        replayCommitHarness = execFileSync("git", ["show", `${replay.replay_tool_commit}:scripts/python-replay-sitecustomize.py`], {
          cwd: process.cwd(),
          encoding: "buffer",
        });
      } catch {
        throw new Error("stored replay tool commit is not resolvable");
      }
      const replayEnvironmentMatches = replay.env !== null
        && typeof replay.env === "object"
        && !Array.isArray(replay.env)
        && artifact.env !== null
        && typeof artifact.env === "object"
        && !Array.isArray(artifact.env)
        && JSON.stringify(Object.entries(replay.env).sort(([left], [right]) => left.localeCompare(right)))
          === JSON.stringify(Object.entries(artifact.env).sort(([left], [right]) => left.localeCompare(right)));
      if (replay.python_commit !== oracleCommit || replay.entrypoint !== artifact.replay_entrypoint
        || replay.fixture_sha256 !== source.capture_sha256 || replay.session_sha256 !== artifact.replay_session_sha256
        || replay.replay_harness_sha256 !== artifact.replay_harness_sha256
        || sha256(replayCommitHarness) !== artifact.replay_harness_sha256
        || JSON.stringify(replay.argv) !== JSON.stringify(artifact.argv)
        || !replayEnvironmentMatches
        || JSON.stringify(replay.env_allowlist) !== JSON.stringify(Object.keys(artifact.env).sort())
        || replay.exit !== artifact.exit || replay.stderr_sha256 !== sha256(artifact.stderr)
        || replay.stdout_sha256 !== artifact.stdout_sha256) {
        throw new Error("stored replay provenance is invalid");
      }

      const caseDirectory = join(root, ...artifact.case.split("/"));
      const caseSource = await readJson(join(caseDirectory, "source.json"));
      if (caseSource.id !== sourceId || caseSource.oracle_output !== artifactPath) {
        throw new Error("case does not reference its Python command output");
      }
      const argv = await readJson(join(caseDirectory, "argv"));
      const env = await readJson(join(caseDirectory, "env"));
      if (JSON.stringify(argv) !== JSON.stringify(artifact.argv) || JSON.stringify(env) !== JSON.stringify(artifact.env)) {
        throw new Error("argv or env differs from the Python command capture");
      }
      const goldenText = await readFile(join(caseDirectory, "stdout.json"), "utf8");
      const golden = JSON.parse(goldenText);
      if (goldenText !== projectionJson(golden)) throw new Error("golden does not use standard JSON formatting");
      const command = artifact.case.split("/", 1)[0];
      const matches = command === "project" || command === "tasks"
        ? projectionJson(parityProjection(artifact.case, golden)) === projectedJson
        : goldenText === artifact.stdout;
      if (!matches) {
        throw new Error("golden parity projection does not match Python evidence");
      }
      if (await readFile(join(caseDirectory, "stderr.txt"), "utf8") !== artifact.stderr
        || Number((await readFile(join(caseDirectory, "exit"), "utf8")).trim()) !== artifact.exit) {
        throw new Error("golden exit or stderr differs from the Python command capture");
      }
    } catch (error) {
      fail(`${sourceId}/${artifactPath}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

for (const relativeCase of requiredOracleCases) {
  const [command, caseName] = relativeCase.split("/");
  const caseDirectory = join(root, command, caseName);
  let argv;
  let exit;
  try {
    argv = await readJson(join(caseDirectory, "argv"));
    exit = Number((await readFile(join(caseDirectory, "exit"), "utf8")).trim());
  } catch (error) {
    if (error?.code === "ENOENT") {
      fail(`${relativeCase}: required oracle case is missing`);
      continue;
    }
    throw error;
  }
  if (JSON.stringify(argv) !== JSON.stringify(requiredOracleCaseArgv[relativeCase]) || !argv.includes("--json") || exit !== 0) {
    fail(`${relativeCase}: required oracle case is not a successful JSON command`);
    continue;
  }
  const caseSource = await readJson(join(caseDirectory, "source.json"));
  const source = oracleById.get(caseSource.id);
  if (!source
    || !isSafeArtifactPath(caseSource.oracle_output)
    || !Array.isArray(source.command_outputs)
    || !source.command_outputs.includes(caseSource.oracle_output)) {
    fail(`${relativeCase}: successful JSON case has no Python command output`);
  }
}

if (oracleSources === 0) fail("No authenticated Python-oracle source is present.");
if (failures === 0) process.stdout.write(`Verified ${oracleSources} Python-oracle source(s) with reproducible fixture replays.\n`);
process.exitCode = failures === 0 ? 0 : 1;
