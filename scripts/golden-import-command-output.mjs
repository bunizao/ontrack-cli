import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";

import {
  hasExactKeys,
  isSafeRelativePath,
  oracleCommit,
  parityProjection,
  projectionJson,
  readJson,
  sha256,
  validateSanitizedJsonStdout,
} from "./golden-command-oracle.mjs";

const [stdoutPath, replayFlag, replayPath, sourceId, caseName, recordedAt, confirmation] = process.argv.slice(2);
if (!stdoutPath || replayFlag !== "--replay-provenance" || !replayPath || !sourceId || !caseName || !recordedAt
  || confirmation !== "--confirm-reproducible-python-replay") {
  process.stderr.write("Usage: node scripts/golden-import-command-output.mjs <stdout.json> --replay-provenance <provenance.json> <source-id> <command/case> <recorded-at-iso> --confirm-reproducible-python-replay\n");
  process.exit(2);
}
if (!/^[a-z0-9][a-z0-9-]*$/u.test(sourceId)) throw new Error("source-id must contain lowercase letters, numbers, and hyphens only");
if (!isSafeRelativePath(caseName)) throw new Error("case must use the command/case-name form");
if (Number.isNaN(new Date(recordedAt).valueOf())) throw new Error("recorded-at-iso must be a valid timestamp");

const root = join(process.cwd(), "tests", "golden");
const sourceDirectory = join(root, "sources", sourceId);
const sourcePath = join(sourceDirectory, "source.json");
const caseDirectory = join(root, ...caseName.split("/"));
const caseSourcePath = join(caseDirectory, "source.json");
const source = await readJson(sourcePath);
const caseSource = await readJson(caseSourcePath);
if (source.kind !== "python_oracle" || source.live_recorded !== true || source.oracle_commit !== oracleCommit) {
  throw new Error(`${sourceId} is not an authenticated Python-oracle source`);
}
if (caseSource.id !== sourceId) {
  const previousSource = await readJson(join(root, "sources", caseSource.id, "source.json"));
  if (previousSource.kind !== "synthetic" || previousSource.live_recorded !== false) {
    throw new Error(`${caseName} is already bound to a different non-synthetic source`);
  }
}
if (caseSource.oracle_output !== undefined) throw new Error(`${caseName} already has a Python command output`);
const fixture = await readFile(join(sourceDirectory, source.fixture));
if (sha256(fixture) !== source.capture_sha256) throw new Error(`${sourceId} HTTP fixture digest does not match its metadata`);
const session = await readFile(join(sourceDirectory, source.session));

const stdoutBuffer = await readFile(stdoutPath);
let committedStdout;
try {
  committedStdout = execFileSync("git", ["show", `HEAD:tests/golden/${caseName}/stdout.json`], {
    cwd: process.cwd(),
    encoding: "buffer",
  });
} catch {
  throw new Error(`Cannot read the committed synthetic golden for ${caseName}`);
}
const stdout = new TextDecoder("utf-8", { fatal: true }).decode(stdoutBuffer);
const pythonValue = validateSanitizedJsonStdout(stdout);
if (stdout !== projectionJson(pythonValue)) {
  throw new Error("Python stdout must use standard JSON formatting");
}
let typescriptValue;
const committedStdoutText = new TextDecoder("utf-8", { fatal: true }).decode(committedStdout);
try {
  typescriptValue = JSON.parse(committedStdoutText);
} catch {
  throw new Error(`Committed TypeScript golden for ${caseName} is not valid JSON`);
}
if (committedStdoutText !== projectionJson(typescriptValue)) {
  throw new Error(`Committed TypeScript golden for ${caseName} must use standard JSON formatting`);
}
const projection = parityProjection(caseName, pythonValue);
const projectedJson = projectionJson(projection);
const command = caseName.split("/", 1)[0];
const hasCorrectnessExemptions = command === "project" || command === "tasks";
if (hasCorrectnessExemptions
  ? projectedJson !== projectionJson(parityProjection(caseName, typescriptValue))
  : !stdoutBuffer.equals(committedStdout)) {
  throw new Error(`Python parity projection does not match the committed TypeScript golden for ${caseName}`);
}
const argv = await readJson(join(caseDirectory, "argv"));
const env = await readJson(join(caseDirectory, "env"));
if (!Array.isArray(argv) || !argv.every((value) => typeof value === "string") || !argv.includes("--json")) {
  throw new Error(`${caseName} is not a JSON command case`);
}
if (env === null || typeof env !== "object" || Array.isArray(env)) throw new Error(`${caseName} has invalid environment metadata`);

const replay = await readJson(replayPath);
const replayKeys = [
  "argv", "entrypoint", "env", "env_allowlist", "exit", "fixture_sha256", "kind", "python_commit",
  "replay_harness_sha256", "replay_tool_commit", "schema", "session_sha256", "stderr_sha256", "stdout_sha256",
];
if (!hasExactKeys(replay, replayKeys) || replay.schema !== 1 || replay.kind !== "python_fixture_replay") {
  throw new Error("replay provenance has an invalid schema");
}
if (replay.python_commit !== oracleCommit) {
  throw new Error("replay provenance does not identify the pinned Python oracle commit");
}
if (replay.entrypoint !== "ontrack_cli.cli") throw new Error("replay provenance has an invalid Python entrypoint");
if (replay.fixture_sha256 !== sha256(fixture) || replay.fixture_sha256 !== source.capture_sha256) {
  throw new Error("replay provenance is not bound to the source HTTP fixture");
}
if (replay.session_sha256 !== sha256(session)) {
  throw new Error("replay provenance is not bound to the source session");
}
let replayHarness;
let replayToolCommit;
try {
  const harnessStatus = execFileSync("git", ["status", "--porcelain", "--", "scripts/python-replay-sitecustomize.py"], {
    cwd: process.cwd(),
    encoding: "utf8",
  });
  if (harnessStatus !== "") throw new Error("dirty harness");
  replayToolCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: process.cwd(), encoding: "utf8" }).trim();
  replayHarness = execFileSync("git", ["show", "HEAD:scripts/python-replay-sitecustomize.py"], {
    cwd: process.cwd(),
    encoding: "buffer",
  });
} catch {
  throw new Error("Cannot read the committed replay harness");
}
if (replay.replay_harness_sha256 !== sha256(replayHarness)) {
  throw new Error("replay provenance is not bound to the committed replay harness");
}
if (replay.replay_tool_commit !== replayToolCommit) {
  throw new Error("replay provenance is not bound to the current clean tool checkout");
}
if (JSON.stringify(replay.argv) !== JSON.stringify(argv)
  || JSON.stringify(replay.env) !== JSON.stringify(env)
  || JSON.stringify(replay.env_allowlist) !== JSON.stringify(Object.keys(env).sort())) {
  throw new Error("replay provenance argv or environment differs from the golden case");
}
if (replay.exit !== 0 || replay.stderr_sha256 !== sha256("") || replay.stdout_sha256 !== sha256(stdoutBuffer)) {
  throw new Error("replay provenance does not identify this successful Python output");
}

const artifactPath = `commands/${caseName}.json`;
const artifact = {
  schema: 4,
  kind: "python_command_output",
  evidence_kind: "reproducible_fixture_replay",
  source_id: sourceId,
  case: caseName,
  oracle_commit: oracleCommit,
  source_capture_sha256: source.capture_sha256,
  recorded_at: new Date(recordedAt).toISOString(),
  argv,
  env,
  replay_entrypoint: replay.entrypoint,
  replay_harness_sha256: replay.replay_harness_sha256,
  replay_session_sha256: replay.session_sha256,
  stdout_sha256: sha256(stdoutBuffer),
  stdout,
  replay_provenance: replay,
  projection,
  projection_sha256: sha256(projectedJson),
  stderr: "",
  exit: 0,
};
const commandOutputs = source.command_outputs ?? [];
if (!Array.isArray(commandOutputs) || !commandOutputs.every((value) => typeof value === "string")) {
  throw new Error(`${sourceId} has invalid command_outputs metadata`);
}
if (commandOutputs.includes(artifactPath)) throw new Error(`${artifactPath} is already registered`);

await mkdir(join(sourceDirectory, "commands", caseName.split("/")[0]), { recursive: true });
await writeFile(join(sourceDirectory, artifactPath), `${JSON.stringify(artifact, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
await Promise.all([
  writeFile(sourcePath, `${JSON.stringify({ ...source, command_outputs: [...commandOutputs, artifactPath].sort() }, null, 2)}\n`, "utf8"),
  writeFile(caseSourcePath, `${JSON.stringify({ ...caseSource, id: sourceId, oracle_output: artifactPath }, null, 2)}\n`, "utf8"),
  writeFile(join(caseDirectory, "stderr.txt"), "", "utf8"),
  writeFile(join(caseDirectory, "exit"), "0\n", "utf8"),
]);
process.stdout.write(`Imported Python stdout for ${caseName} into ${artifactPath}\n`);
