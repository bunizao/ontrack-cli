import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";

import { hasExactKeys, isSafeRelativePath, oracleCommit } from "./golden-command-oracle.mjs";

const [sourceId, confirmation] = process.argv.slice(2);
if (!sourceId || confirmation !== "--confirm-bind-live-oracle") {
  process.stderr.write("Usage: node scripts/golden-bind-oracle-source.mjs <source-id> --confirm-bind-live-oracle\n");
  process.exit(2);
}
if (!/^[a-z0-9][a-z0-9-]*$/u.test(sourceId)) throw new Error("source-id must contain lowercase letters, numbers, and hyphens only");

const root = join(process.cwd(), "tests", "golden");
const source = JSON.parse(await readFile(join(root, "sources", sourceId, "source.json"), "utf8"));
if (source?.kind !== "python_oracle" || source.live_recorded !== true || source.oracle_commit !== oracleCommit) {
  throw new Error("source-id must identify a live recording from the pinned Python oracle");
}
if (source.command_outputs !== undefined && (!Array.isArray(source.command_outputs) || source.command_outputs.length > 0)) {
  throw new Error("source already contains Python command output evidence");
}

const requiredCases = JSON.parse(await readFile(join(root, "oracle-required-cases.json"), "utf8"));
if (requiredCases === null || typeof requiredCases !== "object" || Array.isArray(requiredCases)
  || !Object.keys(requiredCases).every(isSafeRelativePath)) {
  throw new Error("oracle-required-cases.json is invalid");
}

const bindings = await Promise.all(Object.keys(requiredCases).map(async (caseName) => {
  const caseSourcePath = join(root, ...caseName.split("/"), "source.json");
  const caseSource = JSON.parse(await readFile(caseSourcePath, "utf8"));
  if (!hasExactKeys(caseSource, ["id"])) {
    throw new Error(`${caseName} already contains oracle output evidence or invalid source metadata`);
  }
  return caseSourcePath;
}));
await Promise.all(bindings.map((caseSourcePath) => writeFile(
  caseSourcePath,
  `${JSON.stringify({ id: sourceId }, null, 2)}\n`,
  "utf8",
)));

process.stdout.write(`Bound ${Object.keys(requiredCases).length} representative cases to ${sourceId}. Run npm run test:golden:update next.\n`);
