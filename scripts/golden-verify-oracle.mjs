import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";

import {
  hasExactKeys,
  isSafeArtifactPath,
  isSafeRelativePath,
  oracleCommit,
  readJson,
  sha256,
  validateSanitizedJsonStdout,
} from "./golden-command-oracle.mjs";

const root = join(process.cwd(), "tests", "golden");
const sourcesRoot = join(root, "sources");
const artifactKeys = [
  "argv", "case", "env", "exit", "kind", "oracle_commit", "recorded_at", "schema", "source_capture_sha256",
  "source_id", "stderr", "stdout", "stdout_sha256",
];
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
      if (artifact.schema !== 1 || artifact.kind !== "python_command_output") throw new Error("has an invalid schema");
      if (artifact.source_id !== sourceId || artifact.oracle_commit !== oracleCommit) throw new Error("has invalid oracle identity");
      if (artifact.source_capture_sha256 !== source.capture_sha256) throw new Error("is not bound to the HTTP capture");
      if (!isSafeRelativePath(artifact.case) || artifactPath !== `commands/${artifact.case}.json`) throw new Error("has an invalid case path");
      if (Number.isNaN(new Date(artifact.recorded_at).valueOf())) throw new Error("has an invalid recording time");
      if (artifact.exit !== 0 || artifact.stderr !== "") throw new Error("is not a successful JSON command capture");
      if (typeof artifact.stdout !== "string" || sha256(artifact.stdout) !== artifact.stdout_sha256) throw new Error("has an invalid stdout digest");
      validateSanitizedJsonStdout(artifact.stdout);

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
      if (await readFile(join(caseDirectory, "stdout.json"), "utf8") !== artifact.stdout) {
        throw new Error("golden does not match Python stdout");
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

for (const command of await directories(root)) {
  if (command === "sources") continue;
  for (const caseName of await directories(join(root, command))) {
    const relativeCase = `${command}/${caseName}`;
    const caseDirectory = join(root, command, caseName);
    const argv = await readJson(join(caseDirectory, "argv"));
    const exit = Number((await readFile(join(caseDirectory, "exit"), "utf8")).trim());
    if (!Array.isArray(argv) || !argv.includes("--json") || exit !== 0) continue;
    const caseSource = await readJson(join(caseDirectory, "source.json"));
    const source = oracleById.get(caseSource.id);
    if (!source
      || !isSafeArtifactPath(caseSource.oracle_output)
      || !Array.isArray(source.command_outputs)
      || !source.command_outputs.includes(caseSource.oracle_output)) {
      fail(`${relativeCase}: successful JSON case has no Python command output`);
    }
  }
}

if (oracleSources === 0) fail("No authenticated Python-oracle source is present.");
if (failures === 0) process.stdout.write(`Verified ${oracleSources} Python-oracle source(s) with command-output provenance.\n`);
process.exitCode = failures === 0 ? 0 : 1;
