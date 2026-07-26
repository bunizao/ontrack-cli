import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";

import {
  isSafeRelativePath,
  oracleCommit,
  readJson,
  sha256,
  validateSanitizedJsonStdout,
} from "./golden-command-oracle.mjs";

const [stdoutPath, sourceId, caseName, recordedAt, confirmation] = process.argv.slice(2);
if (!stdoutPath || !sourceId || !caseName || !recordedAt || confirmation !== "--confirm-sanitized-python-output") {
  process.stderr.write("Usage: node scripts/golden-import-command-output.mjs <stdout.json> <source-id> <command/case> <recorded-at-iso> --confirm-sanitized-python-output\n");
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
if (!stdoutBuffer.equals(committedStdout)) {
  throw new Error(`Python stdout for ${caseName} does not match the committed synthetic golden`);
}
const stdout = new TextDecoder("utf-8", { fatal: true }).decode(stdoutBuffer);
validateSanitizedJsonStdout(stdout);
const argv = await readJson(join(caseDirectory, "argv"));
const env = await readJson(join(caseDirectory, "env"));
if (!Array.isArray(argv) || !argv.every((value) => typeof value === "string") || !argv.includes("--json")) {
  throw new Error(`${caseName} is not a JSON command case`);
}
if (env === null || typeof env !== "object" || Array.isArray(env)) throw new Error(`${caseName} has invalid environment metadata`);

const artifactPath = `commands/${caseName}.json`;
const artifact = {
  schema: 1,
  kind: "python_command_output",
  source_id: sourceId,
  case: caseName,
  oracle_commit: oracleCommit,
  source_capture_sha256: source.capture_sha256,
  recorded_at: new Date(recordedAt).toISOString(),
  argv,
  env,
  stdout,
  stdout_sha256: sha256(stdoutBuffer),
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
  writeFile(join(caseDirectory, "stdout.json"), stdoutBuffer),
  writeFile(join(caseDirectory, "stderr.txt"), "", "utf8"),
  writeFile(join(caseDirectory, "exit"), "0\n", "utf8"),
]);
process.stdout.write(`Imported Python stdout for ${caseName} into ${artifactPath}\n`);
